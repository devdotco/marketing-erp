"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteEmailCampaign, saveEmailCampaign, type ActionResult } from "@/lib/actions/email-campaigns";
import type { SendgridAudience } from "@/lib/integrations/sendgrid";

export interface CampaignFormValues {
  id: string;
  name: string;
  enabled: boolean;
  templateId: string;
  listIds: string[];
  segmentIds: string[];
  editableSections: string[];
  changeLevel: string;
  sourceUrls: string[];
  brief: string;
  monthlyPush: string;
  sendWeekday: number;
  sendNth: number;
  sendTime: string;
  timezone: string;
  draftWeekday: number;
  draftTime: string;
  notifyEmails: string[];
}

interface TemplateOption {
  id: string;
  name: string;
  sections: { key: string; group: string; kind: string }[];
}

const field: React.CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 12px",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, display: "block", margin: "14px 0 4px" };
const hint: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.6 };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTHS: [number, string][] = [[1, "First"], [2, "Second"], [3, "Third"], [4, "Fourth"], [5, "Fifth"], [-1, "Last"]];

export function CampaignForm({
  values: v,
  templates,
  audiences,
  audienceError,
}: {
  values: CampaignFormValues;
  templates: TemplateOption[];
  audiences: SendgridAudience[];
  audienceError: string | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveEmailCampaign, null);
  const [templateId, setTemplateId] = useState(v.templateId);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const router = useRouter();
  const template = templates.find((t) => t.id === templateId);
  const groups = template ? [...new Set(template.sections.map((s) => s.group))] : [];
  const id = state?.ok ? state.id ?? v.id : v.id;

  // Audiences the campaign points at that SendGrid no longer lists stay visible, so saving never drops them silently.
  const missing = [...v.listIds.map((i) => ({ id: i, kind: "list" as const })), ...v.segmentIds.map((i) => ({ id: i, kind: "segment" as const }))].filter(
    (a) => !audiences.some((x) => x.id === a.id && x.kind === a.kind),
  );

  return (
    <form action={action} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <input type="hidden" name="id" value={id} />

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Campaign type</h2>
        <label style={label}>Name</label>
        <input name="name" defaultValue={v.name} placeholder="Press Release" style={field} required />
        <label style={{ ...label, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" name="enabled" defaultChecked={v.enabled} /> Draft on schedule
        </label>
        <p style={hint}>Off, the campaign only runs when someone presses Draft now.</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Template and latitude</h2>
        <label style={label}>Template</label>
        <select name="templateId" value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={field}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <label style={label}>Sections the agent may change</label>
        {groups.map((g) => {
          const keys = template!.sections.filter((s) => s.group === g);
          return (
            <div key={`${templateId}-${g}`} style={{ fontSize: 12, padding: "4px 0" }}>
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 600 }}>
                <input type="checkbox" name="editableSections" value={g} defaultChecked={v.editableSections.includes(g)} /> {g}
                {keys.length > 1 && <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>(all {keys.length})</span>}
              </label>
              {keys.length > 1 && (
                <span style={{ marginLeft: 12 }}>
                  {keys.map((k) => (
                    <label key={k.key} style={{ display: "inline-flex", gap: 4, alignItems: "center", marginRight: 10, color: "var(--text-muted)" }}>
                      <input type="checkbox" name="editableSections" value={k.key} defaultChecked={v.editableSections.includes(k.key)} /> {k.key}
                    </label>
                  ))}
                </span>
              )}
            </div>
          );
        })}
        <p style={hint}>
          Tick a group to allow every section in it, or single sections only (the Dashboard email allows <code>intro.2</code> but not{" "}
          <code>intro.1</code>). Everything unticked keeps the master&rsquo;s copy.
        </p>

        <label style={label}>How much changes each send</label>
        <select name="changeLevel" defaultValue={v.changeLevel} style={field}>
          <option value="light">A little: just enough that it never looks like a repeat</option>
          <option value="moderate">Some: a new angle, same shape</option>
          <option value="fresh">A lot: a new angle from what we&rsquo;re pushing now</option>
        </select>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>What to write from</h2>
        <label style={label}>Source pages</label>
        <textarea name="sourceUrls" defaultValue={v.sourceUrls.join("\n")} rows={3} style={{ ...field, resize: "vertical" }} placeholder="https://digital.marketing/pricing" />
        <p style={hint}>
          Read on every run. Nothing in the email may come from anywhere else. If none can be read, the run keeps the template&rsquo;s
          facts, only refreshes title, preheader, headline and intro, and flags it.
        </p>
        <label style={label}>This month&rsquo;s push</label>
        <textarea name="monthlyPush" defaultValue={v.monthlyPush} rows={2} style={{ ...field, resize: "vertical" }} placeholder="Leave blank to let the agent take the angle from the source pages" />
        <label style={label}>Standing instructions</label>
        <textarea name="brief" defaultValue={v.brief} rows={8} style={{ ...field, resize: "vertical" }} />
        <p style={hint}>Content rules for this campaign type: what the spotlight features, headline pool, seasonal hooks. Voice comes from Settings → Editorial profile.</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Audience (SendGrid)</h2>
        {audienceError && <p style={{ ...hint, color: "var(--warning)" }}>Couldn&rsquo;t load SendGrid lists: {audienceError}</p>}
        <div style={{ maxHeight: 220, overflow: "auto", marginTop: 8 }}>
          {audiences.map((a) => (
            <label key={`${a.kind}-${a.id}`} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "3px 0" }}>
              <input
                type="checkbox"
                name={a.kind === "list" ? "listIds" : "segmentIds"}
                value={a.id}
                defaultChecked={(a.kind === "list" ? v.listIds : v.segmentIds).includes(a.id)}
              />
              {a.name} <span style={{ color: "var(--text-dim)" }}>{a.kind} · {a.contacts.toLocaleString()} contacts</span>
              {a.contacts < 100 && <span style={{ color: "var(--warning)" }}>under 100</span>}
            </label>
          ))}
          {missing.map((a) => (
            <label key={`missing-${a.id}`} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "3px 0", color: "var(--warning)" }}>
              <input type="checkbox" name={a.kind === "list" ? "listIds" : "segmentIds"} value={a.id} defaultChecked />
              {a.kind} {a.id} (not found in SendGrid)
            </label>
          ))}
        </div>
        <p style={hint}>Attached only when a run is approved. The draft in SendGrid has no recipients until then.</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Calendar: monthly, Nth weekday</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <label style={label}>Week</label>
            <select name="sendNth" defaultValue={v.sendNth} style={field}>
              {NTHS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Send day</label>
            <select name="sendWeekday" defaultValue={v.sendWeekday} style={field}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Send time</label>
            <input name="sendTime" defaultValue={v.sendTime} style={field} placeholder="09:00" />
          </div>
          <div>
            <label style={label}>Draft on the</label>
            <select name="draftWeekday" defaultValue={v.draftWeekday} style={field}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d} before</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Draft time</label>
            <input name="draftTime" defaultValue={v.draftTime} style={field} placeholder="17:47" />
          </div>
          <div>
            <label style={label}>Time zone</label>
            <input name="timezone" defaultValue={v.timezone} style={field} />
          </div>
        </div>
        <label style={label}>Notify when a draft is ready</label>
        <input name="notifyEmails" defaultValue={v.notifyEmails.join(", ")} style={field} placeholder="eric@dev.co" />
        <p style={hint}>Blank sends the heads-up to the workspace admins.</p>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary btn-sm" disabled={pending || templates.length === 0}>{pending ? "Saving…" : "Save campaign type"}</button>
        {id && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              const r = await deleteEmailCampaign(id);
              if (r.ok) router.push("/agents/email-marketing/campaigns");
              else setDeleteError(r.error);
            }}
          >
            Delete
          </button>
        )}
        {state && !state.ok && <span style={{ fontSize: 12, color: "var(--danger)" }}>{state.error}</span>}
        {state?.ok && <span style={{ fontSize: 12, color: "var(--success)" }}>{state.message}</span>}
        {deleteError && <span style={{ fontSize: 12, color: "var(--danger)" }}>{deleteError}</span>}
      </div>
    </form>
  );
}
