import { open } from "node:fs/promises";
import { parseAccessLine } from "./endpoints.mjs";

// Read on an independent timer. Checkpoints and request inserts commit together.
// Rename rotation is drained through .1 before reading the new current file.
export class AccessLogReader {
  constructor(store, file) {
    this.store = store;
    this.file = file;
    this.state = {
      enabled: !!file,
      status: file ? "pending" : "disabled",
      lastReadAt: null,
      lastRequestAt: null,
      lagBytes: 0,
      error: "",
    };
  }
  async read() {
    if (!this.file) return false;
    if (this.pending) return this.pending;
    this.pending = this.readFiles().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async readFiles() {
    let changed = false,
      lag = 0;
    try {
      for (const path of [this.file + ".1", this.file]) {
        let handle;
        try {
          handle = await open(path, "r");
        } catch (error) {
          if (error.code === "ENOENT" && path.endsWith(".1")) continue;
          throw error;
        }
        try {
          const stat = await handle.stat();
          const key = `access:${this.file}:${stat.dev}:${stat.ino}`;
          const saved = JSON.parse(this.store.setting(key) || "0");
          let offset = typeof saved === "number" ? saved : saved.offset;
          const prefix = Buffer.alloc(Math.min(128, stat.size));
          const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
          const head = prefix.subarray(0, prefixRead.bytesRead).toString("hex");
          if (saved.head && !head.startsWith(saved.head)) offset = 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size)
            offset = 0;
          const buffer = Buffer.alloc(Math.min(262144, stat.size - offset));
          if (buffer.length) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              offset,
            );
            const bytes = buffer.subarray(0, bytesRead),
              end = bytes.lastIndexOf(10);
            if (end >= 0) {
              const rows = bytes
                .subarray(0, end)
                .toString("utf8")
                .split("\n")
                .map((line) => parseAccessLine(line))
                .filter(Boolean);
              changed =
                this.store.accessBatch(
                  rows,
                  key,
                  JSON.stringify({ offset: offset + end + 1, head }),
                ) > 0 || changed;
              offset += end + 1;
              if (rows.length)
                this.state.lastRequestAt = Math.max(
                  this.state.lastRequestAt || 0,
                  ...rows.map((row) => row.at),
                );
            } else if (bytes.length === 262144) {
              throw new Error("访问日志存在过长的未结束记录");
            }
          }
          lag += Math.max(0, stat.size - offset);
        } finally {
          await handle.close();
        }
      }
      this.state = {
        ...this.state,
        status: "up",
        lastReadAt: Date.now(),
        lagBytes: lag,
        error: "",
      };
    } catch (error) {
      this.state = {
        ...this.state,
        status: "down",
        error:
          error.code === "ENOENT"
            ? "等待 Nginx 访问日志"
            : error.code === "EACCES"
              ? "访问日志读取权限不足"
              : "访问日志读取失败",
      };
    }
    return changed;
  }
}
