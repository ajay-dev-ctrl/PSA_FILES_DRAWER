import { useMemo, useState } from "react";
import { REQUIREMENT_DOCUMENTS } from "../constants.js";
import { TOTAL_DOCS, useDocumentStatusRows } from "../components/DocumentStatusTable.jsx";

const ATTENTION_LIMIT = 8;
const TOP_DOCS_SHOWN = 8;

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * A ranked horizontal bar. One hue — the number is a magnitude, not a status,
 * so red/green stay reserved for actual state.
 */
function RankBar({ name, value, suffix, ratio, soft }) {
  return (
    <div className="rank-row">
      <div className="rank-label">
        <span className="rank-name">{name}</span>
        <span className="rank-val">
          {value}
          {suffix ? <small> {suffix}</small> : null}
        </span>
      </div>
      <div className="rank-track">
        <div
          className={`rank-fill${soft ? " rank-fill--soft" : ""}`}
          style={{ width: `${Math.max(ratio, 0)}%` }}
        />
      </div>
    </div>
  );
}

export default function Dashboard({ onOpenInAddFiles }) {
  const { rows, loading, error } = useDocumentStatusRows();
  const [showAllDocs, setShowAllDocs] = useState(false);

  const stats = useMemo(() => {
    const total = rows.length;
    const required = total * TOTAL_DOCS;
    const onFile = rows.reduce((sum, r) => sum + r.completedCount, 0);
    return {
      total,
      active: rows.filter((r) => r.recordStatus === "Active").length,
      complete: rows.filter((r) => r.pct >= 100).length,
      required,
      onFile,
      missing: required - onFile,
      compliance: pct(onFile, required),
    };
  }, [rows]);

  // How many people are missing each requirement — the view that says what to
  // ask for next, rather than who to chase.
  const missingByDoc = useMemo(() => {
    if (rows.length === 0) return [];
    return REQUIREMENT_DOCUMENTS
      .map((d) => ({
        item: d.item,
        name: `${d.item}. ${d.name}`,
        missing: rows.filter((r) => !r.completedSet.has(d.item)).length,
      }))
      .filter((d) => d.missing > 0)
      .sort((a, b) => b.missing - a.missing || a.item.localeCompare(b.item));
  }, [rows]);

  const byOffice = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.officeDivision || "unknown";
      const entry = map.get(key) ?? { office: key, people: 0, onFile: 0 };
      entry.people += 1;
      entry.onFile += r.completedCount;
      map.set(key, entry);
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, compliance: pct(e.onFile, e.people * TOTAL_DOCS) }))
      .sort((a, b) => a.compliance - b.compliance || a.office.localeCompare(b.office));
  }, [rows]);

  const needsAttention = useMemo(
    () =>
      [...rows]
        .filter((r) => r.pct < 100)
        .sort((a, b) => a.completedCount - b.completedCount || a.name.localeCompare(b.name))
        .slice(0, ATTENTION_LIMIT),
    [rows]
  );

  const visibleDocs = showAllDocs ? missingByDoc : missingByDoc.slice(0, TOP_DOCS_SHOWN);

  if (loading) {
    return (
      <>
        <div className="page-header">
          <div className="page-header-title">Dashboard</div>
          <div className="page-header-sub">Where the agency stands on document compliance</div>
        </div>
        <div className="empty">Loading…</div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="page-header">
          <div className="page-header-title">Dashboard</div>
          <div className="page-header-sub">Where the agency stands on document compliance</div>
        </div>
        <div className="empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header-title">Dashboard</div>
        <div className="page-header-sub">Where the agency stands on document compliance</div>
      </div>

      {/* ── Headline numbers ── */}
      <div className="stat-row">
        <div className="stat-tile stat-tile--lead">
          <div className="stat-tile__label">Employees</div>
          <div className="stat-tile__value">{stats.total}</div>
          <div className="stat-tile__foot">{stats.active} active</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">Compliance</div>
          <div className="stat-tile__value">{stats.compliance}%</div>
          <div className="stat-tile__foot">{stats.onFile} of {stats.required} documents</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">
            <span className="stat-dot stat-dot--miss" aria-hidden="true" />
            Documents missing
          </div>
          <div className="stat-tile__value">{stats.missing}</div>
          <div className="stat-tile__foot">across the agency</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">
            <span className="stat-dot stat-dot--ok" aria-hidden="true" />
            Fully complete
          </div>
          <div className="stat-tile__value">{stats.complete}</div>
          <div className="stat-tile__foot">
            {stats.complete === 0 ? `nobody reaches ${TOTAL_DOCS}/${TOTAL_DOCS}` : `of ${stats.total} employees`}
          </div>
        </div>
      </div>

      {/* ── Which document is missing for the most people ── */}
      <section className="panel">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Most-missing documents
          </h3>
          <span className="panel-meta">of {stats.total} employees</span>
        </div>

        {missingByDoc.length === 0 ? (
          <div className="empty">Every requirement is on file for everyone.</div>
        ) : (
          <>
            <div className="rank-bars">
              {visibleDocs.map((d) => (
                <RankBar
                  key={d.item}
                  name={d.name}
                  value={d.missing}
                  suffix={`/ ${stats.total}`}
                  ratio={pct(d.missing, stats.total)}
                  soft={d.missing < stats.total}
                />
              ))}
            </div>
            {missingByDoc.length > TOP_DOCS_SHOWN && (
              <button
                type="button"
                className="ghost-button rank-more"
                onClick={() => setShowAllDocs((v) => !v)}
              >
                {showAllDocs
                  ? "Show top 8"
                  : `Show all ${missingByDoc.length} with gaps`}
              </button>
            )}
          </>
        )}
      </section>

      {/* ── Where to chase ── */}
      <div className="dash-split">
        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              By office / division
            </h3>
          </div>
          {byOffice.length === 0 ? (
            <div className="empty">No employees yet.</div>
          ) : (
            <div className="rank-bars">
              {byOffice.map((o) => (
                <RankBar
                  key={o.office}
                  name={`${o.office} · ${o.people} ${o.people === 1 ? "person" : "people"}`}
                  value={`${o.compliance}%`}
                  ratio={o.compliance}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Needs attention
            </h3>
            <span className="panel-meta">fewest documents first</span>
          </div>
          {needsAttention.length === 0 ? (
            <div className="empty">Nobody is missing anything.</div>
          ) : (
            <div className="att-list">
              {needsAttention.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`att-row${r.completedCount === 0 ? " att-row--zero" : ""}`}
                  title={`Open ${r.name} in Employees`}
                  onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                >
                  <span className="att-name">{r.name}</span>
                  <span className="att-office">{r.officeDivision}</span>
                  <span className={`att-count${r.completedCount === 0 ? " att-count--zero" : ""}`}>
                    {r.completedCount}/{TOTAL_DOCS}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
