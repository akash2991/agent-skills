// Hand-written decoder for GET /jobs/{id}. Closed: unknown keys and missing keys are rejected,
// so the web must change in the same release as any JobDetail change.
export type JobDetail = { id: string; post_id: string; status: "queued" | "running" | "done" };

const KEYS = ["id", "post_id", "status"] as const;

export function decodeJobDetail(raw: unknown): JobDetail {
  if (typeof raw !== "object" || raw === null) throw new Error("JobDetail: not an object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new Error(`JobDetail: unknown key ${key}`);
  }
  for (const key of KEYS) {
    if (!(key in obj)) throw new Error(`JobDetail: missing key ${key}`);
  }
  return obj as JobDetail;
}
