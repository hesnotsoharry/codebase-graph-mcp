/**
 * indexingWorkerTypes.test.ts — Compile-time and runtime smoke tests for the
 * indexing worker message discriminated unions.
 */

import { describe, expect, it } from 'vitest';

import type {
  IndexingWorkerRequest,
  IndexingWorkerResponse,
  IndexRepositoryRequest,
  WorkerErrorMessage,
  WorkerProgressMessage,
  WorkerResultMessage,
} from './indexingWorkerTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIndexRequest(overrides?: Partial<IndexRepositoryRequest>): IndexRepositoryRequest {
  return {
    type: 'indexRepository',
    requestId: 'req-1',
    options: { projectRoot: '/tmp/proj', projectName: 'proj' },
    ...overrides,
  };
}

function makeProgressMsg(overrides?: Partial<WorkerProgressMessage>): WorkerProgressMessage {
  return {
    type: 'progress',
    requestId: 'req-1',
    progress: {
      phase: 'parsing',
      filesTotal: 10,
      filesProcessed: 5,
      nodesCreated: 0,
      edgesCreated: 0,
      errors: [],
      startedAt: Date.now(),
      elapsedMs: 100,
    },
    ...overrides,
  };
}

function makeResultMsg(overrides?: Partial<WorkerResultMessage>): WorkerResultMessage {
  return {
    type: 'result',
    requestId: 'req-1',
    result: {
      projectName: 'proj',
      success: true,
      filesIndexed: 10,
      filesSkipped: 0,
      nodesCreated: 50,
      edgesCreated: 20,
      errors: [],
      durationMs: 500,
      incremental: false,
    },
    ...overrides,
  };
}

function makeErrorMsg(overrides?: Partial<WorkerErrorMessage>): WorkerErrorMessage {
  return {
    type: 'error',
    requestId: 'req-1',
    message: 'something went wrong',
    ...overrides,
  };
}

// ── Request narrowing ─────────────────────────────────────────────────────────

describe('IndexingWorkerRequest', () => {
  it('narrows to IndexRepositoryRequest on type guard', () => {
    const msg: IndexingWorkerRequest = makeIndexRequest();
    expect(msg.type).toBe('indexRepository');
    if (msg.type === 'indexRepository') {
      expect(msg.requestId).toBe('req-1');
      expect(msg.options.projectRoot).toBe('/tmp/proj');
    }
  });

  it('options does not contain onProgress (not serialisable)', () => {
    const req = makeIndexRequest();
    expect('onProgress' in req.options).toBe(false);
  });
});

// ── Response narrowing ────────────────────────────────────────────────────────

describe('IndexingWorkerResponse', () => {
  it('narrows to WorkerProgressMessage', () => {
    const msg: IndexingWorkerResponse = makeProgressMsg();
    if (msg.type === 'progress') {
      expect(msg.progress.phase).toBe('parsing');
      expect(msg.progress.filesTotal).toBe(10);
    } else {
      throw new Error('expected progress');
    }
  });

  it('narrows to WorkerResultMessage', () => {
    const msg: IndexingWorkerResponse = makeResultMsg();
    if (msg.type === 'result') {
      expect(msg.result.success).toBe(true);
      expect(msg.result.filesIndexed).toBe(10);
    } else {
      throw new Error('expected result');
    }
  });

  it('narrows to WorkerErrorMessage', () => {
    const msg: IndexingWorkerResponse = makeErrorMsg();
    if (msg.type === 'error') {
      expect(msg.message).toBe('something went wrong');
      expect(msg.requestId).toBe('req-1');
    } else {
      throw new Error('expected error');
    }
  });

  it('all three response types carry requestId', () => {
    const msgs: IndexingWorkerResponse[] = [
      makeProgressMsg({ requestId: 'x' }),
      makeResultMsg({ requestId: 'x' }),
      makeErrorMsg({ requestId: 'x' }),
    ];
    for (const msg of msgs) {
      expect(msg.requestId).toBe('x');
    }
  });
});

// ── JSON round-trip ───────────────────────────────────────────────────────────

describe('JSON serialisability', () => {
  it('IndexRepositoryRequest survives JSON round-trip', () => {
    const req = makeIndexRequest();
    const rt = JSON.parse(JSON.stringify(req)) as typeof req;
    expect(rt.type).toBe('indexRepository');
    expect(rt.options.projectRoot).toBe('/tmp/proj');
  });

  it('WorkerResultMessage survives JSON round-trip', () => {
    const msg = makeResultMsg();
    const rt = JSON.parse(JSON.stringify(msg)) as typeof msg;
    expect(rt.result.nodesCreated).toBe(50);
  });
});
