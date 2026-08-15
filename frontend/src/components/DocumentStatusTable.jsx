import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { REQUIREMENT_DOCUMENTS } from "../constants.js";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
export const TOTAL_DOCS = REQUIREMENT_DOCUMENTS.length;

export function progressBand(pct) {
  if (pct >= 70) return "high";
  if (pct >= 30) return "partial";
  return "low";
}

/**
 * Fetches /dashboard/summary and shapes it into table rows. Shared by the
 * Dashboard and Employees pages so both stay in sync off one payload shape.
 */
export function useDocumentStatusRows() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Re-fetchable so completion counts update after an upload or delete.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/dashboard/summary`, { credentials: "include" });
      if (r.status === 401) { window.location.replace("/login.html"); return; }
      if (!r.ok) throw new Error("Could not load dashboard data.");
      setEmployees(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const rows = useMemo(() => employees.map((e) => {
    const completedSet = new Set(e.completed_items ?? []);
    const completedCount = REQUIREMENT_DOCUMENTS.filter((d) => completedSet.has(d.item)).length;
    return {
      id: e.id,
      name: e.name || "Unnamed user",
      position: e.position || "No position",
      employeeId: e.employee_id || "",
      employmentStatus: e.employment_status || "",
      recordStatus: e.record_status || "Active",
      officeDivision: e.office_division || "unknown",
      // Null until the employee has at least one file — drives the stale list.
      lastUploadAt: e.last_upload_at ? new Date(e.last_upload_at) : null,
      completedSet,
      completedCount,
      pct: TOTAL_DOCS ? Math.round((completedCount / TOTAL_DOCS) * 100) : 0,
    };
  }), [employees]);

  return { rows, loading, error, refresh };
}

/** Compact letter chips (A–Q), colour-coded by completion. Used on Dashboard. */
function DocumentChips({ completedSet, onSelect }) {
  return (
    <>
      {REQUIREMENT_DOCUMENTS.map((d) => {
        const done = completedSet.has(d.item);
        return (
          <button
            key={d.item}
            type="button"
            className={`dash-missing-chip${done ? " dash-missing-chip--done" : ""}`}
            title={`${d.name} — click to open in Employees`}
            onClick={() => onSelect?.(d.item)}
          >
            {d.item}
          </button>
        );
      })}
    </>
  );
}

/**
 * Full document names in the same "A. Appointment (CS FORM 33)" format as the
 * upload dropdown, so the row reads the same as the select. Used on Employees.
 */
function DocumentNameList({ completedSet, onSelect }) {
  return (
    <ul className="dash-doc-list">
      {REQUIREMENT_DOCUMENTS.map((d) => {
        const done = completedSet.has(d.item);
        return (
          <li key={d.item}>
            <button
              type="button"
              className={`dash-doc-item${done ? " dash-doc-item--done" : ""}`}
              title={done ? "Uploaded — click to view or add more" : "Missing — click to upload"}
              onClick={() => onSelect?.(d.item)}
            >
              <span className="dash-doc-check" aria-hidden="true">
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 16 16">
                    <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
                  </svg>
                )}
              </span>
              <span className="dash-doc-label">{d.item}. {d.name}</span>
              <span className="dash-doc-state">{done ? "Uploaded" : "Missing"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function DocumentStatusTable({
  rows,
  loading,
  error,
  variant = "chips",
  title = "Document Status",
  emptyMessage = "No employees match the current filters.",
  onOpenInAddFiles,
  // Controlled single-expand: when `onToggleRow` is supplied the parent owns
  // which row is open (so it can load that employee's files). Otherwise the
  // table manages its own multi-row expansion.
  expandedId,
  onToggleRow,
  renderExpanded,
  rowActions,
}) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [tableCollapsed, setTableCollapsed] = useState(false);
  const controlled = typeof onToggleRow === "function";
  const colCount = rowActions ? 6 : 5;

  const isRowExpanded = (id) => (controlled ? expandedId === id : expandedIds.has(id));

  function toggleExpanded(id) {
    if (controlled) { onToggleRow(id); return; }
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <section className="panel" id="dashboard-table">
      <div className="section-heading">
        <h3 className="panel-title">
          <span className="panel-title-dot" />
          {title}
        </h3>
        <button
          type="button"
          className={`dash-expand-toggle${tableCollapsed ? "" : " dash-expand-toggle--open"}`}
          aria-expanded={!tableCollapsed}
          aria-label={tableCollapsed ? "Show document status table" : "Hide document status table"}
          title={tableCollapsed ? "Show table" : "Hide table"}
          onClick={() => setTableCollapsed((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      </div>
      {tableCollapsed ? null : loading ? (
        <div className="empty">Loading…</div>
      ) : error ? (
        <div className="empty">{error}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{emptyMessage}</div>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Position</th>
                <th>Office / Division</th>
                <th>Progress</th>
                {rowActions ? <th>Actions</th> : null}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isExpanded = isRowExpanded(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="dash-name-link"
                          aria-expanded={onOpenInAddFiles ? undefined : isExpanded}
                          title={
                            onOpenInAddFiles
                              ? "Open in Employees to attach documents"
                              : isExpanded ? "Hide documents" : "Show documents"
                          }
                          // On Employees the name opens the documents right here;
                          // on Dashboard it jumps to the Employees page instead.
                          onClick={() =>
                            onOpenInAddFiles
                              ? onOpenInAddFiles(r.id, r.name)
                              : toggleExpanded(r.id)
                          }
                        >
                          {r.name}
                        </button>
                        {(r.employeeId || r.recordStatus !== "Active") && (
                          <div className="dash-name-meta">
                            {r.employeeId}
                            {r.employeeId && r.recordStatus !== "Active" ? " · " : ""}
                            {r.recordStatus !== "Active" && (
                              <span className="dash-inactive-tag">{r.recordStatus}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{r.position}</td>
                      <td>{r.officeDivision}</td>
                      <td>
                        <div className="dash-table-progress">
                          <div className="dash-table-progress-track">
                            <div
                              className={`dash-progress-fill dash-progress-fill--${progressBand(r.pct)}`}
                              style={{ width: `${r.pct}%` }}
                            />
                          </div>
                          <span className="dash-table-progress-count">{r.completedCount}/{TOTAL_DOCS}</span>
                        </div>
                      </td>
                      {rowActions ? <td className="dash-row-actions">{rowActions(r)}</td> : null}
                      <td>
                        <button
                          type="button"
                          className={`dash-expand-toggle${isExpanded ? " dash-expand-toggle--open" : ""}`}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? "Hide documents" : "Show documents"}
                          title={isExpanded ? "Hide documents" : "Show documents"}
                          onClick={() => toggleExpanded(r.id)}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16">
                            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="dash-table-detail-row">
                        <td colSpan={colCount}>
                          {renderExpanded ? (
                            renderExpanded(r)
                          ) : (
                            <div className="dash-card-details">
                              <div className="dash-card-detail-row">
                                <span className="dash-card-detail-label">Documents</span>
                                {variant === "list" ? (
                                  <DocumentNameList
                                    completedSet={r.completedSet}
                                    onSelect={(item) => onOpenInAddFiles?.(r.id, r.name, item)}
                                  />
                                ) : (
                                  <span className="dash-missing-cell">
                                    <DocumentChips
                                      completedSet={r.completedSet}
                                      onSelect={(item) => onOpenInAddFiles?.(r.id, r.name, item)}
                                    />
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
