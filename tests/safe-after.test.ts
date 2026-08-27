import { beforeEach, describe, expect, it, vi } from "vitest";

type AfterCallback = () => void | Promise<void>;

const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn<(callback: AfterCallback) => void>(),
}));

vi.mock("next/server", () => ({
  after: afterMock,
}));

const { safeAfter } = await import("../src/safe-after.js");

function getRegisteredCallback(): AfterCallback {
  const call = afterMock.mock.calls[0];

  if (call === undefined) {
    throw new Error("Expected safeAfter to register an after callback");
  }

  return call[0];
}

describe("safeAfter", () => {
  beforeEach(() => {
    afterMock.mockReset();
    vi.restoreAllMocks();
  });

  it("registers a tracked callback without running the task immediately", async () => {
    const task = vi.fn(async (): Promise<void> => undefined);

    safeAfter(task);

    expect(afterMock).toHaveBeenCalledOnce();
    expect(task).not.toHaveBeenCalled();

    const result = getRegisteredCallback()();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledOnce();
  });

  it("reports a rejected task through the supplied logger", async () => {
    const taskError = new Error("receipt delivery failed");
    const logger = vi.fn((_err: any): void => undefined);

    safeAfter(async (): Promise<void> => {
      throw taskError;
    }, logger);

    await expect(getRegisteredCallback()()).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(taskError);
  });

  it("uses the default logger when no logger is supplied", async () => {
    const taskError = new Error("analytics write failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((): void => undefined);

    safeAfter(async (): Promise<void> => {
      throw taskError;
    });

    await expect(getRegisteredCallback()()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[safeAfter] Background task failed",
      taskError,
    );
  });

  it("contains an asynchronous logger rejection", async () => {
    const taskError = new Error("background task failed");
    const loggerError = new Error("monitoring service failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((): void => undefined);
    const logger = vi.fn(async (_err: any): Promise<void> => {
      throw loggerError;
    });

    safeAfter(async (): Promise<void> => {
      throw taskError;
    }, logger);

    await expect(getRegisteredCallback()()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[safeAfter] Error logger failed",
      { loggerError, taskError },
    );
  });
});
