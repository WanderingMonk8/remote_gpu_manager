import { describe, expect, test } from "bun:test";
import { JobTracker } from "../host-gateway/job-tracker";
const id = "123e4567-e89b-42d3-a456-426614174000";
describe("job shutdown protection", () => {
  test("holds while submitted and running; only a matching completion clears it", () => {
    const tracker = new JobTracker();
    tracker.submissionStarted();
    expect(tracker.blocksIdle()).toBe(true);
    tracker.submissionFinished(200, { prompt_id: id });
    tracker.websocket(JSON.stringify({ type: "executing", data: { prompt_id: "other", node: null } }));
    expect(tracker.snapshot().state).toBe("active");
    tracker.websocket(JSON.stringify({ type: "execution_success", data: { prompt_id: id } }));
    expect(tracker.blocksIdle()).toBe(false);
  });
  test("ambiguous failures and malformed successes block idle shutdown", () => {
    for (const [status, body] of [[null, null], [200, {}], [502, {}]] as const) {
      const tracker = new JobTracker(); tracker.submissionStarted(); tracker.submissionFinished(status, body);
      expect(tracker.snapshot().state).toBe("uncertain");
      expect(tracker.blocksIdle()).toBe(true);
    }
  });
  test("confirmed rejected submissions do not hold runtime, while completed history clears a job", () => {
    const tracker = new JobTracker(); tracker.submissionStarted(); tracker.submissionFinished(400, {});
    expect(tracker.blocksIdle()).toBe(false);
    tracker.submissionStarted(); tracker.submissionFinished(200, { prompt_id: id });
    tracker.history(id, { [id]: { status: { completed: true } } });
    expect(tracker.blocksIdle()).toBe(false);
  });
  test("restored uncertain state holds until an explicit runtime-end reset", () => {
    const tracker = new JobTracker(); tracker.restoreUncertain();
    expect(tracker.blocksIdle()).toBe(true);
    tracker.reset(); expect(tracker.blocksIdle()).toBe(false);
  });
});
