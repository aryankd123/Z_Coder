'use strict';

/**
 * The execution service: submit a run, process it, report it.
 *
 *   POST /api/executions
 *     -> submit(): check room membership (editor+ for a room run), check
 *        queue capacity, insert a submission { status: 'queued' }, enqueue,
 *        tell the room ("queued"), return it (the controller answers 202).
 *   queue worker
 *     -> process(): claim it (queued -> running, atomically), tell the room,
 *        executor.run(), toVerdict(), store the result (-> finished), tell
 *        the room. That's the shared console: everyone in the room sees
 *        each run's status change live via `execution:update`.
 *   GET /api/executions/:id
 *     -> get(): the polling fallback (and for private runs, the only way).
 *
 * The service doesn't care which queue or executor it gets (ports and
 * adapters): MemoryQueue + Local/Judge0 today, BullMQ + Docker later.
 */
const { Submission } = require('../models/Submission');
const { User } = require('../models/User');
const { toVerdict } = require('./verdict');
const roomService = require('../services/roomService');
const { AppError, notFound, forbidden } = require('../lib/errors');
const { logger } = require('../lib/logger');

/** Everything about a run except the code and input (those are on the detail view only). */
const SUMMARY_PROJECTION = Object.freeze({ source: 0, stdin: 0 });

/**
 * @param {any} s a submission (lean or hydrated)
 * @param {{ withInput?: boolean }} [options] include source and stdin
 */
function toPublicSubmission(s, { withInput = false } = {}) {
  return {
    id: String(s._id),
    userId: String(s.userId),
    userName: s.userName ?? '',
    roomId: s.roomId ? String(s.roomId) : null,
    language: s.language,
    status: s.status,
    verdict: s.verdict ?? null,
    stdout: s.stdout ?? '',
    stderr: s.stderr ?? '',
    compileOutput: s.compileOutput ?? '',
    exitCode: s.exitCode ?? null,
    timeMs: s.timeMs ?? null,
    queuedAt: s.queuedAt,
    startedAt: s.startedAt ?? null,
    finishedAt: s.finishedAt ?? null,
    ...(withInput && { source: s.source, stdin: s.stdin }),
  };
}

/**
 * @param {{
 *   queue: import('./queue/memoryQueue').MemoryQueue,
 *   executor: { name: string, run: Function },
 *   realtime: { emitToRoom: Function },
 *   limits: { runTimeoutMs: number, compileTimeoutMs: number, memoryMb: number, outputBytes: number },
 * }} deps
 */
function createExecutionService({ queue, executor, realtime, limits }) {
  const announce = (submission) => {
    if (submission?.roomId) realtime.emitToRoom(String(submission.roomId), 'execution:update', toPublicSubmission(submission));
  };
  const cap = (s) => (s ?? '').slice(0, limits.outputBytes);

  /**
   * Run one queued submission. Never throws: whatever happens, the
   * submission ends up 'finished' with a verdict.
   * @param {{ data: { submissionId: string } }} job
   */
  async function processJob(job) {
    const { submissionId } = job.data;
    // Atomic claim: only a submission still 'queued' moves to 'running'.
    // If recovery or another worker already took it, we do nothing.
    const running = await Submission.findOneAndUpdate(
      { _id: submissionId, status: 'queued' },
      { $set: { status: 'running', startedAt: new Date() } },
      { new: true },
    ).lean();
    if (!running) return null;
    announce(running);

    let raw;
    try {
      raw = await executor.run({ language: running.language, source: running.source, stdin: running.stdin, limits });
    } catch (err) {
      // Executors shouldn't throw, but if one does it's our failure, not the user's.
      logger.error({ err, submissionId, executor: executor.name }, 'executor threw');
      raw = { internalError: true, stderr: 'The code runner failed unexpectedly' };
    }
    const verdict = toVerdict(raw);

    const finished = await Submission.findByIdAndUpdate(
      submissionId,
      {
        $set: {
          status: 'finished',
          verdict,
          stdout: cap(raw.stdout),
          stderr: cap(raw.stderr),
          compileOutput: cap(raw.compile?.output),
          exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
          timeMs: typeof raw.timeMs === 'number' ? raw.timeMs : null,
          finishedAt: new Date(),
        },
      },
      { new: true },
    ).lean();
    announce(finished);
    return verdict;
  }

  queue.process(processJob);
  queue.on('failed', (job, err) => logger.error({ err, jobId: job.id }, 'execution job failed'));

  /**
   * @param {string} userId
   * @param {{ roomId?: string, language: string, source: string, stdin: string }} input validated
   * @throws {AppError} 404 ROOM_NOT_FOUND, 403 ROOM_FORBIDDEN, 503 QUEUE_FULL
   */
  async function submit(userId, { roomId, language, source, stdin }) {
    let userName;
    if (roomId) {
      const room = await roomService.findRoomForMember(roomId, userId);
      if (!room) throw notFound('ROOM_NOT_FOUND', 'Room not found');
      const member = roomService.findMember(room, userId);
      // Viewers watch the shared console; editors and the owner run code.
      if (!roomService.roleAtLeast(member.role, 'editor')) {
        throw forbidden('ROOM_FORBIDDEN', 'Viewers cannot run code in this room');
      }
      userName = member.name;
    } else {
      userName = (await User.findById(userId, { name: 1 }).lean())?.name ?? '';
    }

    // Backpressure: refuse BEFORE writing anything.
    if (queue.isFull) throw new AppError(503, 'QUEUE_FULL', 'Too many runs are waiting; try again in a moment');

    const submission = await Submission.create({
      userId,
      userName,
      roomId: roomId ?? null,
      language,
      source,
      stdin,
      status: 'queued',
      queuedAt: new Date(),
    });
    const queued = queue.add(String(submission._id), { submissionId: String(submission._id) });
    if (!queued) {
      // The queue filled between the check and the add (or is shutting down).
      await Submission.updateOne(
        { _id: submission._id },
        { $set: { status: 'finished', verdict: 'INTERNAL_ERROR', stderr: 'The run queue is full', finishedAt: new Date() } },
      );
      throw new AppError(503, 'QUEUE_FULL', 'Too many runs are waiting; try again in a moment');
    }
    announce(submission);
    return toPublicSubmission(submission);
  }

  /**
   * One run, with its source and stdin. Visible to the person who ran it,
   * and, for a room run, to every member of that room. Anyone else gets 404.
   * @param {string} userId
   * @param {string} id
   */
  async function get(userId, id) {
    const s = await Submission.findById(id).lean();
    if (!s) throw notFound('EXECUTION_NOT_FOUND', 'Run not found');
    const allowed = s.roomId ? Boolean(await roomService.findRoomForMember(s.roomId, userId)) : String(s.userId) === userId;
    if (!allowed) throw notFound('EXECUTION_NOT_FOUND', 'Run not found');
    return toPublicSubmission(s, { withInput: true });
  }

  /**
   * A room's run history, newest first: the { roomId: 1, _id: -1 } index.
   * @param {string} roomId (membership already checked by requireRoomMember)
   * @param {{ before?: string, limit: number }} query
   */
  async function listForRoom(roomId, { before, limit }) {
    const filter = { roomId };
    if (before) filter._id = { $lt: before };
    const docs = await Submission.find(filter, SUMMARY_PROJECTION).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const executions = docs.slice(0, limit).map((d) => toPublicSubmission(d));
    return { executions, nextCursor: hasMore ? executions.at(-1).id : null };
  }

  /**
   * At boot: runs that were queued or running when the process died can
   * never finish (the in-memory queue lost them). Mark them failed instead of
   * leaving them "running" forever. At-most-once: we don't re-run user code.
   */
  async function recoverStale() {
    const res = await Submission.updateMany(
      { status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'finished',
          verdict: 'INTERNAL_ERROR',
          stderr: 'The server restarted before this run finished. Run it again.',
          finishedAt: new Date(),
        },
      },
    );
    return res.modifiedCount;
  }

  return {
    submit,
    get,
    listForRoom,
    recoverStale,
    processJob,
    stats: () => queue.stats(),
    close: () => queue.close(),
    executorName: executor.name,
  };
}

module.exports = { createExecutionService, toPublicSubmission };
