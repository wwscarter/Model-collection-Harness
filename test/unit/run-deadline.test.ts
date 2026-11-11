import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPauseGroup, createRunDeadline, type RunDeadline } from '../../src/core/agent/RunDeadline';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let deadline: RunDeadline | undefined;
afterEach(() => { deadline?.dispose(); deadline = undefined; });

describe('createRunDeadline', () => {
  it('does not count time spent holding for an external operation', async () => {
    const clock = createRunDeadline(60);
    deadline = clock;
    clock.hold();
    await sleep(140);
    expect(clock.signal.aborted).toBe(false);
    clock.release();
    await vi.waitFor(() => expect(clock.signal.aborted).toBe(true), { timeout: 1_000 });
  });

  it('resumes only after the last nested hold is released', async () => {
    const clock = createRunDeadline(80);
    deadline = clock;
    clock.hold();
    clock.hold();
    await sleep(120);
    clock.release();
    await sleep(90);
    expect(clock.signal.aborted).toBe(false);
    clock.release();
    await vi.waitFor(() => expect(clock.signal.aborted).toBe(true), { timeout: 1_000 });
  });

  it('stops the clock when disposed', async () => {
    deadline = createRunDeadline(30);
    deadline.dispose();
    await sleep(80);
    expect(deadline.signal.aborted).toBe(false);
  });
});

describe('createPauseGroup', () => {
  it('pauses once and resumes only after every nested hold is released', () => {
    const pause = vi.fn(() => vi.fn());
    const hold = createPauseGroup(pause);
    const first = hold();
    const second = hold();
    expect(pause).toHaveBeenCalledTimes(1);
    first();
    first(); // releasing twice is harmless
    expect(pause.mock.results[0].value).not.toHaveBeenCalled();
    second();
    expect(pause.mock.results[0].value).toHaveBeenCalledTimes(1);
  });
});
