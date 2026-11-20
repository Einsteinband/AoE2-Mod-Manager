import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelInstall,
  clearResume,
  installMod,
  pauseInstall,
} from "../service";
import {
  downloadTasks,
  enqueueDownload,
  requestCancelTask,
  requestPauseTask,
  requestResumeTask,
} from "../downloadQueue";
import type { InstallCommandResponse } from "../types";

vi.mock("../service", () => ({
  cancelInstall: vi.fn().mockResolvedValue(undefined),
  clearResume: vi.fn().mockResolvedValue(undefined),
  installMod: vi.fn(),
  loadDownloadQueue: vi.fn().mockResolvedValue({ tasks: [] }),
  onDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
  pauseInstall: vi.fn().mockResolvedValue(undefined),
  saveDownloadQueue: vi.fn().mockResolvedValue(undefined),
}));

const mockedInstallMod = vi.mocked(installMod);

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const completedOutcome = {
  install: { targetDir: "local/test", updated: false, fileCount: 1, bytes: 10, backupDir: null },
  downloadedBytes: 10,
  assets: { infoJsonWritten: false, infoJsonPath: null, thumbnailName: null, message: "" },
  localized: true,
  finalDir: "local/test",
  finalPath: "local//test",
  statusNote: "",
  statusBackupPath: null,
  note: "",
};

describe("downloadQueue 暂停 / 继续状态机", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadTasks.value = [];
  });

  it("暂停回执保留已下载进度与续传凭据，不进入完成状态", async () => {
    mockedInstallMod.mockResolvedValueOnce({
      phase: "paused",
      download: {
        zipPath: "temp/mod.zip",
        bytes: 512,
        total: 1024,
        workDir: "temp",
        status: "paused",
      },
    });

    const result = enqueueDownload({
      modId: 900001,
      title: "Resume Pause",
      kind: "install",
    });
    await flush();

    expect(result.accepted).toBe(true);
    const task = downloadTasks.value.find((item) => item.modId === 900001);
    expect(task).toBeTruthy();
    expect(task?.status).toBe("paused");
    expect(task?.progress?.received).toBe(512);
    expect(task?.progress?.total).toBe(1024);
    expect(task?.resume).toEqual({ expectedTotal: 1024 });
    expect(task?.finishedAt).toBeNull();
    expect(mockedInstallMod).toHaveBeenCalledWith(
      900001,
      "Resume Pause",
      false,
      task?.id,
      false,
      [],
      [],
      null,
      null,
      null,
    );
  });

  it("继续任务时把 resume 标记传给后端，并从排队状态重新进入泵", async () => {
    mockedInstallMod
      .mockResolvedValueOnce({
        phase: "paused",
        download: {
          zipPath: "temp/mod.zip",
          bytes: 512,
          total: 1024,
          workDir: "temp",
          status: "paused",
        },
      })
      .mockResolvedValueOnce({ phase: "completed", outcome: completedOutcome });

    enqueueDownload({ modId: 900002, title: "Resume Continue", kind: "install" });
    await flush();
    const paused = downloadTasks.value.find((item) => item.modId === 900002);
    expect(paused?.status).toBe("paused");

    requestResumeTask(paused!.id);
    await flush();

    expect(mockedInstallMod).toHaveBeenNthCalledWith(
      2,
      900002,
      "Resume Continue",
      false,
      paused?.id,
      true,
      [],
      [],
      null,
      null,
      null,
    );
    expect(paused?.status).toBe("done");
  });

  it("下载中请求暂停只登记按任务的暂停标记", async () => {
    let resolveInstall: (value: InstallCommandResponse) => void = () => undefined;
    mockedInstallMod.mockReturnValueOnce(
      new Promise<InstallCommandResponse>((resolve) => {
        resolveInstall = resolve;
      }),
    );

    enqueueDownload({ modId: 900003, title: "Pause Request", kind: "install" });
    await flush();
    const task = downloadTasks.value.find((item) => item.modId === 900003);
    expect(task?.status).toBe("downloading");

    requestPauseTask(task!.id);
    expect(task?.pauseRequested).toBe(true);
    expect(pauseInstall).toHaveBeenCalledWith(task?.id);

    resolveInstall({ phase: "completed", outcome: completedOutcome });
    await flush();
  });

  it("暂停后取消会清理后端续传登记并置为 cancelled", async () => {
    mockedInstallMod.mockResolvedValueOnce({
      phase: "paused",
      download: {
        zipPath: "temp/mod.zip",
        bytes: 512,
        total: 1024,
        workDir: "temp",
        status: "paused",
      },
    });

    enqueueDownload({ modId: 900004, title: "Paused Cancel", kind: "install" });
    await flush();
    const paused = downloadTasks.value.find((item) => item.modId === 900004);
    expect(paused?.status).toBe("paused");

    requestCancelTask(paused!.id);
    expect(paused?.status).toBe("cancelled");
    expect(paused?.resume).toBeNull();
    expect(clearResume).toHaveBeenCalledWith(paused?.id);
    expect(cancelInstall).not.toHaveBeenCalled();
  });

  it("续传失败后清除前端续传凭据，避免再次按失效登记继续", async () => {
    mockedInstallMod
      .mockResolvedValueOnce({
        phase: "paused",
        download: {
          zipPath: "temp/mod.zip",
          bytes: 512,
          total: 1024,
          workDir: "temp",
          status: "paused",
        },
      })
      .mockRejectedValueOnce(new Error("resume segment mismatch"));

    enqueueDownload({ modId: 900005, title: "Resume Failure", kind: "install" });
    await flush();
    const paused = downloadTasks.value.find((item) => item.modId === 900005);
    expect(paused?.status).toBe("paused");

    requestResumeTask(paused!.id);
    await flush();

    expect(paused?.status).toBe("failed");
    expect(paused?.resume).toBeNull();
  });
});
