import { checkTrackedReleases } from "./check.js";

const DEFAULT_INTERVAL_SECONDS = 300;
const MINIMUM_INTERVAL_SECONDS = 60;

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  if (!env.CONTROL_SECRET) return false;
  return request.headers.get("Authorization") === `Bearer ${env.CONTROL_SECRET}`;
}

function checkerStub(env) {
  return env.CHECKER.get(env.CHECKER.idFromName("primary"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (!authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    const stub = checkerStub(env);
    if (request.method === "GET" && url.pathname === "/control/status") {
      return stub.fetch("https://checker/status");
    }
    if (request.method === "POST" && url.pathname === "/control/start") {
      return stub.fetch("https://checker/start", { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/control/run") {
      return stub.fetch("https://checker/run", { method: "POST" });
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    if (!env.GITHUB_TOKEN) return;
    ctx.waitUntil(
      checkerStub(env).fetch("https://checker/start", { method: "POST" }),
    );
  },
};

export class ReleaseChecker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  intervalMilliseconds() {
    const configured = Number.parseInt(this.env.CHECK_INTERVAL_SECONDS, 10);
    const seconds = Number.isFinite(configured)
      ? Math.max(configured, MINIMUM_INTERVAL_SECONDS)
      : DEFAULT_INTERVAL_SECONDS;
    return seconds * 1000;
  }

  nextAlarmTime(now = Date.now()) {
    const interval = this.intervalMilliseconds();
    return Math.ceil((now + 1000) / interval) * interval;
  }

  async scheduleNextAlarm() {
    const scheduledAt = this.nextAlarmTime();
    await this.state.storage.setAlarm(scheduledAt);
    return scheduledAt;
  }

  async status() {
    const status = (await this.state.storage.get("status")) ?? {
      state: "not-started",
    };
    const alarm = await this.state.storage.getAlarm();
    return { ...status, nextAlarmAt: alarm ? new Date(alarm).toISOString() : null };
  }

  async recordStatus(update) {
    const previous = (await this.state.storage.get("status")) ?? {};
    await this.state.storage.put("status", { ...previous, ...update });
  }

  async ensureAlarm() {
    const existing = await this.state.storage.getAlarm();
    const scheduledAt = existing ?? (await this.scheduleNextAlarm());
    await this.recordStatus({
      state: "scheduled",
      scheduledAt: new Date(scheduledAt).toISOString(),
    });
    return this.status();
  }

  async runCheck() {
    const attemptedAt = new Date().toISOString();
    await this.recordStatus({ state: "running", lastAttemptAt: attemptedAt });
    try {
      const result = await checkTrackedReleases(this.env);
      await this.recordStatus({
        state: "scheduled",
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastResult: result,
      });
      return result;
    } catch (error) {
      await this.recordStatus({
        state: "error",
        lastAttemptAt: attemptedAt,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await this.status());
    }
    if (request.method === "POST" && url.pathname === "/start") {
      return json(await this.ensureAlarm());
    }
    if (request.method === "POST" && url.pathname === "/run") {
      try {
        const result = await this.runCheck();
        await this.scheduleNextAlarm();
        return json({ ok: true, result, status: await this.status() });
      } catch (error) {
        await this.scheduleNextAlarm();
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            status: await this.status(),
          },
          500,
        );
      }
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(alarmInfo) {
    try {
      await this.runCheck();
      await this.scheduleNextAlarm();
    } catch (error) {
      if ((alarmInfo?.retryCount ?? 0) >= 6) {
        await this.scheduleNextAlarm();
        return;
      }
      throw error;
    }
  }
}
