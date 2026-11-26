'use strict';

const { Schema, model, Types } = require('mongoose');

const STATUSES = Object.freeze(['queued', 'running', 'finished']);
const VERDICTS = Object.freeze([
  'OK',
  'COMPILE_ERROR',
  'RUNTIME_ERROR',
  'TIME_LIMIT',
  'MEMORY_LIMIT',
  'INTERNAL_ERROR',
]);
const MAX_SOURCE_BYTES = 64 * 1024;

/**
 * submissions: one document per code run (filled in Phase 4).
 *
 * Lifecycle: queued -> running -> finished (with a verdict). The timestamps
 * queuedAt / startedAt / finishedAt let us measure queue wait
 * (startedAt - queuedAt) and run time separately.
 *
 * Indexes:
 *   { roomId: 1, _id: -1 } - room run history, newest first (the shared console)
 *   { userId: 1, _id: -1 } - "my submissions", newest first
 */
const submissionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    // Copied at submit time (like messages.senderName), so the room's
    // shared console can say "Alice ran this" without a users lookup.
    userName: { type: String, default: '' },
    roomId: { type: Types.ObjectId, ref: 'Room', default: null },
    language: { type: String, required: true },
    source: { type: String, required: true, maxlength: MAX_SOURCE_BYTES },
    stdin: { type: String, default: '', maxlength: MAX_SOURCE_BYTES },
    status: { type: String, enum: STATUSES, default: 'queued' },
    verdict: { type: String, enum: [...VERDICTS, null], default: null },
    stdout: { type: String, default: '' },
    stderr: { type: String, default: '' },
    compileOutput: { type: String, default: '' },
    exitCode: { type: Number, default: null },
    timeMs: { type: Number, default: null },
    queuedAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

submissionSchema.index({ roomId: 1, _id: -1 });
submissionSchema.index({ userId: 1, _id: -1 });

const Submission = model('Submission', submissionSchema, 'submissions');

module.exports = { Submission, STATUSES, VERDICTS, MAX_SOURCE_BYTES };
