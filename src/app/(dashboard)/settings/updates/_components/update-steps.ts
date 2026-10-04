// Progress rows of an update request (pure, unit-tested): which of backup / pull / migrate / restart / healthcheck is
// done, running, waiting or failed, given the status + step the `updater` wrote.
import { UPDATE_STEPS, type UpdateRequestStatus, type UpdateStepName } from "@/lib/update-types"

export type StepState = "done" | "current" | "todo" | "failed"

export interface StepRow {
  step: UpdateStepName
  state: StepState
}

export function stepRows(req: { status: UpdateRequestStatus; step: UpdateStepName | null }): StepRow[] {
  const main = UPDATE_STEPS as readonly UpdateStepName[]
  const idx = req.step && req.step !== "rollback" ? main.indexOf(req.step) : -1
  const rows: StepRow[] = main.map((step, i) => {
    let state: StepState
    switch (req.status) {
      case "pending":
        state = "todo"
        break
      case "succeeded":
        state = "done"
        break
      case "running":
        // step not reported yet = the first one is starting
        state = idx === -1 ? (i === 0 ? "current" : "todo") : i < idx ? "done" : i === idx ? "current" : "todo"
        break
      case "failed":
        state = idx === -1 ? (i === 0 ? "failed" : "todo") : i < idx ? "done" : i === idx ? "failed" : "todo"
        break
      case "rolled_back":
        // the failing step is not recorded once the updater moved on to `rollback`: show what we know
        state = idx === -1 ? "todo" : i < idx ? "done" : i === idx ? "failed" : "todo"
        break
    }
    return { step, state }
  })
  if (req.step === "rollback" || req.status === "rolled_back") {
    rows.push({ step: "rollback", state: req.status === "running" ? "current" : "done" })
  }
  return rows
}

/** Request that finished (no longer pending/running). */
export function isFinished(status: UpdateRequestStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "rolled_back"
}
