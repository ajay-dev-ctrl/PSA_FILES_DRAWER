import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import psaLogo from "./psa-logo.png";
import { REQUIREMENT_DOCUMENTS } from "./constants.js";
import Dashboard from "./pages/Dashboard.jsx";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

// Stable empty object — passed to closed cards so file-state changes never
// trigger re-renders for cards the user isn't looking at.
const EMPTY_FILES = {};

// ── Module-level utilities (no state dependency) ──────────────────────────────

async function viewFile(memoryId, docItem) {
  try {
    const res = await fetch(`${apiUrl}/files/${memoryId}/${docItem}/view`, {
      credentials: "include"
    });
    if (!res.ok) throw new Error("Could not load file.");
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  } catch (err) {
    alert(err.message);
  }
}

function downloadFile(memoryId, docItem, fileId, filename) {
  const downloadUrl = `${apiUrl}/files/${memoryId}/${docItem}/${fileId}/download`;
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = filename || "document.pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── CustomSelect — fully styled dropdown replacing native <select> ────────────
function CustomSelect({ value, onChange, options, placeholder, style, dropdownHeight = 280 }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={wrapRef} style={{ position: "relative", ...style }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center",
          justifyContent: "space-between", gap: 8,
          padding: "9px 13px",
          border: open ? "1.5px solid #4a90d9" : "1.5px solid var(--border-2)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          color: selected ? "var(--text)" : "#a8bcd4",
          fontSize: "0.95rem", fontWeight: 400,
          cursor: "pointer", textAlign: "left",
          boxShadow: open ? "0 0 0 3px rgba(74,144,217,0.12)" : "none",
          transition: "border-color 0.15s, box-shadow 0.15s",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.label : placeholder}
        </span>
        <svg width="14" height="14" viewBox="0 0 16 16" style={{ flexShrink: 0, transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
          <path d="M4 6l4 4 4-4" stroke="#637491" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 500,
          width: "max-content", minWidth: "100%",
          background: "var(--surface)", border: "1px solid var(--border-2)",
          borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}>
          <div style={{ maxHeight: dropdownHeight, overflowY: dropdownHeight === "none" ? "visible" : "auto", scrollbarWidth: "thin", scrollbarColor: "#c4d4e8 transparent" }}>
            {options.map((opt, i) => (
              <button
                key={opt.value}
                type="button"
                title={opt.label}
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  width: "100%", padding: "5px 14px",
                  background: opt.value === value ? "#f0f6ff" : "transparent",
                  color: opt.value === value ? "var(--psa-blue)" : "var(--text)",
                  fontWeight: opt.value === value ? 700 : 400,
                  border: 0,
                  borderBottom: i < options.length - 1 ? "1px solid #f0f4fb" : 0,
                  borderRadius: 0, textAlign: "left", cursor: "pointer",
                  fontSize: "0.85rem", whiteSpace: "nowrap",
                  transition: "background 0.1s", gap: 16,
                }}
                onMouseEnter={e => { if (opt.value !== value) e.currentTarget.style.background = "#f2f7ff"; }}
                onMouseLeave={e => { if (opt.value !== value) e.currentTarget.style.background = "transparent"; }}
              >
                <span>{opt.label}</span>
                {(opt.complete || opt.badge != null) && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {opt.complete && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2e7d46" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {opt.badge != null && (
                      <span style={{
                        fontSize: "0.9rem", fontWeight: 500,
                        color: opt.value === value ? "var(--psa-blue)" : "#888",
                      }}>
                        {opt.badge}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── UserCard — memoized so only re-renders when its own props change ──────────

const UserCard = memo(function UserCard({
  memory,
  isOpen,
  uploadedFiles,
  initialDocItem,
  onToggle,
  onEdit,
  onUpload,
  onDownload,
  onDelete,
  onDeleteUser,
}) {
  const [selectedItem, setSelectedItem] = useState("");

  useEffect(() => {
    if (isOpen && initialDocItem) setSelectedItem(initialDocItem);
  }, [isOpen, initialDocItem]);

  const selectedDoc  = REQUIREMENT_DOCUMENTS.find(d => d.item === selectedItem);
  const selectedSlot = selectedItem ? uploadedFiles[selectedItem] : null;
  const uploadedList = REQUIREMENT_DOCUMENTS.filter(d => (uploadedFiles[d.item]?.files ?? []).length > 0);

  return (
    <article className="job-card">
      <div
        className="job-card__header"
        onClick={() => onToggle(memory.id)}
        style={{ cursor: "pointer" }}
      >
        <div className="job-card__info">
          <div className="job-card__name">
            {memory.content?.name ?? "Unnamed user"}
          </div>
          <div className="job-card__tags">
            <span className="job-card__tag">
              {memory.content?.position ?? "No position"}
            </span>
            {(memory.content?.officeDivision || memory.content?.source) && (
              <>
                <span className="job-card__tag-sep">·</span>
                <span className="job-card__tag">
                  {memory.content?.officeDivision || memory.content?.source}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="card-actions">
          <button
            className="edit-button"
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(memory); }}
          >
            Edit
          </button>
          <button
            type="button"
            title="Delete employee"
            onClick={(e) => { e.stopPropagation(); onDeleteUser(memory); }}
            style={{
              width: 36, height: 36, padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: "var(--radius-sm)", background: "#fee2e2", color: "#991b1b",
              border: "1.5px solid #fecaca", cursor: "pointer", flexShrink: 0,
              transition: "background 0.12s",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "#fecaca"}
            onMouseLeave={e => e.currentTarget.style.background = "#fee2e2"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/>
              <path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>

      {isOpen && (
        <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)", padding: "22px 24px", borderRadius: "0 0 var(--radius) var(--radius)" }}>

          {/* ── Document selector — always-expanded list, no dropdown ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-label)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Select Document Type
              </span>
              {selectedItem && (
                <>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    id={`file-${memory.id}-${selectedItem}`}
                    style={{ display: "none" }}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(memory.id, selectedItem, f);
                      e.target.value = "";
                    }}
                  />
                  {selectedSlot?.uploading ? (
                    <span className="file-uploading" style={{ whiteSpace: "nowrap" }}>
                      <span className="upload-spinner" /> Uploading…
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => document.getElementById(`file-${memory.id}-${selectedItem}`).click()}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      Upload File
                    </button>
                  )}
                </>
              )}
            </div>

            <CustomSelect
              value={selectedItem}
              onChange={val => setSelectedItem(val)}
              placeholder="— Choose a document to upload —"
              dropdownHeight="none"
              options={REQUIREMENT_DOCUMENTS.map(doc => {
                const count = (uploadedFiles[doc.item]?.files ?? []).length;
                return {
                  value: doc.item,
                  label: `${doc.item}. ${doc.name}`,
                  badge: count > 0 ? count : null,
                  complete: count > 0,
                };
              })}
            />

            {selectedSlot?.errMsg && (
              <div style={{ marginTop: 10, padding: "10px 14px", background: "#fff1f0", border: "1.5px solid #ffd6d3", borderRadius: 10, color: "#b42318", fontSize: "0.86rem", fontWeight: 600 }}>
                ⚠ Upload failed — {selectedSlot.errMsg}
              </div>
            )}
            {selectedSlot && (selectedSlot.files ?? []).length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {(selectedSlot.files ?? []).map((f) => (
                  <div key={f.id} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", background: "var(--surface)",
                    border: "1px solid var(--border)", borderRadius: 8
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--psa-blue)" style={{ flexShrink: 0 }}>
                      <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/>
                    </svg>
                    <span style={{ flex: 1, fontSize: "0.84rem", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.filename}
                    </span>
                    <button
                      type="button"
                      title={`View ${f.filename}`}
                      onClick={() => viewFile(memory.id, selectedItem)}
                      style={{
                        width: 32, height: 32, minWidth: 32, padding: 0,
                        borderRadius: "var(--radius-sm)", background: "#dbeafe",
                        color: "#1d4ed8", border: 0, cursor: "pointer",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        transition: "background 0.12s", flexShrink: 0
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = "#bfdbfe"}
                      onMouseLeave={e => e.currentTarget.style.background = "#dbeafe"}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="dl-btn"
                      title={`Download ${f.filename}`}
                      onClick={() => onDownload(memory.id, selectedItem, f.id, f.filename)}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      title="Delete this file"
                      onClick={() => onDelete(memory.id, selectedItem, f.id, f.filename)}
                      style={{
                        width: 32, height: 32, minWidth: 32, padding: 0,
                        borderRadius: "var(--radius-sm)", background: "#fee2e2",
                        color: "#991b1b", border: 0, cursor: "pointer",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        transition: "background 0.12s", flexShrink: 0
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = "#fecaca"}
                      onMouseLeave={e => e.currentTarget.style.background = "#fee2e2"}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {uploadedList.length === 0 && !selectedItem && (
            <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.88rem", padding: "16px 0" }}>
              No documents uploaded yet. Select a document type above to upload.
            </div>
          )}

        </div>
      )}
    </article>
  );
});

// ── Shared admin button style ─────────────────────────────────────────────────
function adminBtn(color) {
  const map = {
    green: { bg: "#166534", text: "#ffffff", border: "#166534" },
    red:   { bg: "#c0392b", text: "#ffffff", border: "#c0392b" },
  };
  const c = map[color];
  return {
    padding: "6px 16px", minWidth: 72, height: 32,
    background: c.bg, color: c.text,
    border: `1.5px solid ${c.border}`,
    borderRadius: 6,
    fontWeight: 700, fontSize: "0.82rem",
    cursor: "pointer", transition: "opacity 0.12s",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [activePage,       setActivePage]       = useState("dashboard");
  const [openMemoryId,     setOpenMemoryId]      = useState("");
  const [pendingDocItem,   setPendingDocItem]    = useState("");
  const [personName,       setPersonName]        = useState("");
  const [position,         setPosition]          = useState("");
  const [officeDivision,   setOfficeDivision]    = useState("");
  const [position2,        setPosition2]         = useState("");
  const [officeDivision2,  setOfficeDivision2]   = useState("");
  const [secondAssignmentMsg, setSecondAssignmentMsg] = useState("");
  const [searchTerm,       setSearchTerm]        = useState("");
  const [userMatches,      setUserMatches]       = useState([]);
  const [isSearching,      setIsSearching]       = useState(false);
  const [dropdownOpen,     setDropdownOpen]      = useState(false);
  const [topUsers,         setTopUsers]          = useState([]);
  const [positions,        setPositions]         = useState([]);
  const [memories,         setMemories]          = useState([]);
  const [nextCursor,       setNextCursor]        = useState(null);
  const [isLoadingMore,    setIsLoadingMore]     = useState(false);
  const [editingMemoryId,  setEditingMemoryId]   = useState("");
  const [isSubmitting,     setIsSubmitting]      = useState(false);
  const [error,            setError]             = useState("");
  const [uploadedFiles,    setUploadedFiles]     = useState({});
  const [currentUser,      setCurrentUser]       = useState(null);
  const [isAdmin,          setIsAdmin]           = useState(false);
  const [authChecked,      setAuthChecked]       = useState(false);
  const [avatarUrl,        setAvatarUrl]         = useState(null);
  const [sidebarOpen,      setSidebarOpen]       = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 780
  );

  // Profile / change password
  const [pwCurrent,        setPwCurrent]         = useState("");
  const [pwNew,            setPwNew]             = useState("");
  const [pwConfirm,        setPwConfirm]         = useState("");
  const [pwError,          setPwError]           = useState("");
  const [pwSuccess,        setPwSuccess]         = useState("");
  const [pwLoading,        setPwLoading]         = useState(false);

  // Admin — pending registrations
  const [pendingUsers,     setPendingUsers]      = useState([]);
  const [pendingLoading,   setPendingLoading]    = useState(false);

  // Admin — all managed users
  const [allUsers,         setAllUsers]          = useState([]);
  const [allUsersLoading,  setAllUsersLoading]   = useState(false);

  const esRef        = useRef(null);
  const avatarInputRef = useRef(null);

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const visibleUsers     = normalizedSearch ? userMatches : memories;

  const savedPositions = useMemo(() => {
    const vals = memories.map((m) => m.content?.position).filter(Boolean);
    return [...new Set(vals)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }, [memories]);

  const savedOfficeDivisions = useMemo(() => {
    const vals = memories
      .map((m) => m.content?.officeDivision || m.content?.source)
      .filter(Boolean);
    return [...new Set(vals)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }, [memories]);

  const savedPositions2 = useMemo(() => {
    const vals = memories.map((m) => m.content?.position2).filter(Boolean);
    return [...new Set(vals)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }, [memories]);

  const savedOfficeDivisions2 = useMemo(() => {
    const vals = memories.map((m) => m.content?.officeDivision2).filter(Boolean);
    return [...new Set(vals)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }, [memories]);

  // ── Auth check on mount — redirect to login if not authenticated ──────────────
  useEffect(() => {
    fetch(`${apiUrl}/auth/me`, { credentials: "include" })
      .then((r) => {
        if (r.status === 401) {
          window.location.replace("/login.html");
        } else if (r.ok) {
          return r.json().then(async (data) => {
            setCurrentUser(data.username);
            setIsAdmin(!!data.isAdmin);
            if (data.hasAvatar) {
              try {
                const imgRes = await fetch(`${apiUrl}/auth/avatar-proxy`, { credentials: "include" });
                if (imgRes.ok) {
                  const blob = await imgRes.blob();
                  setAvatarUrl(URL.createObjectURL(blob));
                }
              } catch {
                // avatar unavailable — show initials fallback
              }
            }
          });
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  // ── Stable data fetcher ──────────────────────────────────────────────────────
  const refreshData = useCallback(async ({ append = false, cursor } = {}) => {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);

    const [resJobs, resMem] = await Promise.all([
      fetch(`${apiUrl}/jobs`, { credentials: "include" }),
      fetch(`${apiUrl}/memories?${params}`, { credentials: "include" }),
    ]);
    if (!resJobs.ok || !resMem.ok) throw new Error("Could not load saved data.");

    const jobsData = await resJobs.json();
    const memData  = await resMem.json();  // { items, nextCursor }

    setPositions(jobsData);
    setMemories((prev) => append ? [...prev, ...memData.items] : memData.items);
    setNextCursor(memData.nextCursor);
  }, []);

  // ── SSE replaces polling ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!authChecked) return;
    refreshData().catch((e) => setError(e.message));

    const es = new EventSource(`${apiUrl}/events`, { withCredentials: true });
    esRef.current = es;

    es.addEventListener("refresh", () => {
      refreshData().catch(() => {});
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [authChecked, refreshData]);

  // ── Load files when a card is opened ────────────────────────────────────────
  useEffect(() => {
    if (!openMemoryId) { setUploadedFiles({}); return; }
    fetch(`${apiUrl}/files/${openMemoryId}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : [])
      .then((rows) => {
        const map = {};
        for (const f of rows) {
          if (!map[f.docItem]) map[f.docItem] = { uploading: false, errMsg: null, files: [] };
          map[f.docItem].files.push({ id: f.id, filename: f.filename, sizeBytes: f.sizeBytes });
        }
        setUploadedFiles(map);
      })
      .catch(() => {});
  }, [openMemoryId]);

  // ── Stable card handlers ─────────────────────────────────────────────────────
  const handleToggle = useCallback((id) => {
    setPendingDocItem("");
    setOpenMemoryId((prev) => {
      if (prev !== id) {
        // Record open as a search hit — O(log n) Redis sorted set increment
        fetch(`${apiUrl}/users/${id}/search-hit`, { method: "POST", credentials: "include" }).catch(() => {});
      }
      return prev === id ? "" : id;
    });
  }, []);

  // Load top 10 most-searched users when Add Files page becomes active.
  // Falls back to 10 most recent users when Redis has no frequency data yet.
  useEffect(() => {
    if (activePage !== "find-user") return;
    fetch(`${apiUrl}/users/top`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(async (rows) => {
        if (rows.length > 0) { setTopUsers(rows); return; }
        // No frequency data yet — fall back to 10 most recent
        const res = await fetch(`${apiUrl}/memories?limit=10`, { credentials: "include" });
        if (res.ok) { const d = await res.json(); setTopUsers(d.items ?? []); }
      })
      .catch(() => {});
  }, [activePage]);

  const handleEdit = useCallback((user) => {
    setEditingMemoryId(user.id);
    setPersonName(user.content?.name ?? "");
    setPosition(user.content?.position ?? "");
    setOfficeDivision(user.content?.officeDivision ?? user.content?.source ?? "");
    setPosition2(user.content?.position2 ?? "");
    setOfficeDivision2(user.content?.officeDivision2 ?? "");
    setActivePage("new-user");
  }, []);

  const uploadFile = useCallback(async (memoryId, docItem, file) => {
    setUploadedFiles((prev) => ({
      ...prev,
      [docItem]: { ...(prev[docItem] ?? { files: [] }), uploading: true, errMsg: null }
    }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiUrl}/files/${memoryId}/${docItem}`, {
        method: "POST",
        body: fd,
        credentials: "include"
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed.");
      }
      const data = await res.json();
      setUploadedFiles((prev) => {
        const slot = prev[docItem] ?? { files: [] };
        return {
          ...prev,
          [docItem]: {
            uploading: false, errMsg: null,
            files: [...slot.files, { id: data.id, filename: data.filename, sizeBytes: data.sizeBytes }]
          }
        };
      });
    } catch (err) {
      setUploadedFiles((prev) => ({
        ...prev,
        [docItem]: { ...(prev[docItem] ?? { files: [] }), uploading: false, errMsg: err.message }
      }));
    }
  }, []);

  const deleteUser = useCallback(async (memory) => {
    const name = memory.content?.name ?? "this user";
    if (!window.confirm(
      `Delete "${name}"?\n\nThis will permanently remove the employee record, their position, office, and ALL uploaded documents.\n\nThis cannot be undone.`
    )) return;
    try {
      const res = await fetch(`${apiUrl}/memories/${memory.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete user.");
      }
      await refreshData();
      setTopUsers(prev => prev.filter(m => m.id !== memory.id));
    } catch (err) {
      alert(err.message);
    }
  }, [refreshData]);

  const deleteFile = useCallback(async (memoryId, docItem, fileId, filename) => {
    if (!window.confirm(`Delete "${filename}"?\n\nThis cannot be undone.`)) return;
    try {
      const res = await fetch(`${apiUrl}/files/${memoryId}/${docItem}/${fileId}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!res.ok) throw new Error("Could not delete file.");
      setUploadedFiles((prev) => {
        const slot = prev[docItem];
        if (!slot) return prev;
        return {
          ...prev,
          [docItem]: { ...slot, files: slot.files.filter((f) => f.id !== fileId) }
        };
      });
    } catch (err) {
      alert(err.message);
    }
  }, []);

  // ── Avatar upload ─────────────────────────────────────────────────────────────
  const uploadAvatar = useCallback(async (file) => {
    // Show instant local preview — no network needed
    const localPreview = URL.createObjectURL(file);
    setAvatarUrl(localPreview);

    const fd = new FormData();
    fd.append("avatar", file);
    try {
      const res = await fetch(`${apiUrl}/auth/avatar`, {
        method: "POST",
        body: fd,
        credentials: "include"
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        URL.revokeObjectURL(localPreview);
        setAvatarUrl(null);
        throw new Error(body.error ?? "Upload failed.");
      }
      // Keep the local preview showing — server has saved it.
      // On next page load, /auth/me will return the persisted URL.
    } catch (err) {
      alert(err.message);
    }
  }, []);

  // ── Sign out ──────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(async () => {
    await fetch(`${apiUrl}/auth/logout`, {
      method: "POST",
      credentials: "include"
    }).catch(() => {});
    window.location.replace("/login.html");
  }, []);

  // ── Change password ───────────────────────────────────────────────────────────
  const changePassword = useCallback(async (e) => {
    e.preventDefault();
    setPwError(""); setPwSuccess("");
    if (!pwCurrent) return setPwError("Enter your current password.");
    if (pwNew.length < 8 || !/[A-Z]/.test(pwNew) || !/[0-9]/.test(pwNew) || !/[^A-Za-z0-9]/.test(pwNew)) {
      return setPwError("New password needs 8+ chars, uppercase, number, and symbol.");
    }
    if (pwNew !== pwConfirm) return setPwError("New passwords do not match.");
    setPwLoading(true);
    try {
      const res = await fetch(`${apiUrl}/auth/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPwSuccess("Password changed successfully.");
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwLoading(false);
    }
  }, [pwCurrent, pwNew, pwConfirm]);

  // ── Admin: pending users ──────────────────────────────────────────────────────
  const loadPendingUsers = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await fetch(`${apiUrl}/admin/pending-users`, { credentials: "include" });
      if (res.ok) setPendingUsers(await res.json());
    } catch { /* ignore */ } finally {
      setPendingLoading(false);
    }
  }, []);

  const loadAllUsers = useCallback(async () => {
    setAllUsersLoading(true);
    try {
      const res = await fetch(`${apiUrl}/admin/users`, { credentials: "include" });
      if (res.ok) setAllUsers(await res.json());
    } catch { /* ignore */ } finally {
      setAllUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activePage === "profile" && isAdmin) {
      loadPendingUsers();
      loadAllUsers();
    }
  }, [activePage, currentUser, loadPendingUsers, loadAllUsers]);

  const handleApprove = useCallback(async (userId) => {
    const res = await fetch(`${apiUrl}/admin/approve/${userId}`, {
      method: "POST", credentials: "include",
    });
    if (res.ok) {
      setPendingUsers(prev => prev.filter(u => u.id !== userId));
      setAllUsers(prev => prev.map(u => u.id === userId ? { ...u, status: "active" } : u));
    }
  }, []);

  const handleReject = useCallback(async (userId, username) => {
    if (!window.confirm(`Reject and remove "${username}"? This cannot be undone.`)) return;
    const res = await fetch(`${apiUrl}/admin/reject/${userId}`, {
      method: "POST", credentials: "include",
    });
    if (res.ok) {
      setPendingUsers(prev => prev.filter(u => u.id !== userId));
      setAllUsers(prev => prev.filter(u => u.id !== userId));
    }
  }, []);

  const handleDeleteSystemUser = useCallback(async (userId, username) => {
    if (!window.confirm(`Delete account "${username}"?\n\nThis will permanently remove their login access. This cannot be undone.`)) return;
    const res = await fetch(`${apiUrl}/admin/users/${userId}`, {
      method: "DELETE", credentials: "include",
    });
    if (res.ok) setAllUsers(prev => prev.filter(u => u.id !== userId));
  }, []);

  const handleBlock = useCallback(async (userId) => {
    const res = await fetch(`${apiUrl}/admin/block/${userId}`, {
      method: "POST", credentials: "include",
    });
    if (res.ok) setAllUsers(prev => prev.map(u => u.id === userId ? { ...u, status: "blocked" } : u));
  }, []);

  const handleUnblock = useCallback(async (userId) => {
    const res = await fetch(`${apiUrl}/admin/unblock/${userId}`, {
      method: "POST", credentials: "include",
    });
    if (res.ok) setAllUsers(prev => prev.map(u => u.id === userId ? { ...u, status: "active" } : u));
  }, []);

  // ── Pagination ───────────────────────────────────────────────────────────────
  async function loadMore() {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      await refreshData({ append: true, cursor: nextCursor });
    } catch (e) {
      setError(e.message);
    } finally {
      setIsLoadingMore(false);
    }
  }

  // ── Form helpers ─────────────────────────────────────────────────────────────
  function resetForm() {
    setPersonName(""); setPosition(""); setOfficeDivision("");
    setPosition2(""); setOfficeDivision2(""); setEditingMemoryId("");
  }

  async function submitUser(e) {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    const payload = {
      name: personName, position, officeDivision,
      ...(position2 ? { position2 } : {}),
      ...(officeDivision2 ? { officeDivision2 } : {}),
      submittedAt: new Date().toISOString(),
    };
    try {
      const res = await fetch(
        editingMemoryId ? `${apiUrl}/memories/${editingMemoryId}` : `${apiUrl}/jobs`,
        {
          method: editingMemoryId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(
            editingMemoryId
              ? { updates: { name: personName, position, officeDivision, position2, officeDivision2 } }
              : { payload }
          ),
        }
      );
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? (editingMemoryId ? "Could not update user." : "Could not save user."));
      }
      await refreshData();
      resetForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function saveSecondAssignment() {
    if (!editingMemoryId) {
      setError("Save the employee first (Save User above), then you can add an additional assignment.");
      return;
    }
    setError("");
    try {
      const res = await fetch(`${apiUrl}/memories/${editingMemoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ updates: { position2, officeDivision2 } }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Could not save additional assignment.");
      }
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearSecondAssignment() {
    setPosition2("");
    setOfficeDivision2("");
    if (!editingMemoryId) return;
    try {
      const res = await fetch(`${apiUrl}/memories/${editingMemoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ updates: { position2: "", officeDivision2: "" } }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Could not remove additional assignment.");
      }
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  function goToFindUser(e) { e.preventDefault(); setActivePage("find-user"); }

  // ── Search debounce ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!normalizedSearch) { setUserMatches([]); setIsSearching(false); return; }
    setIsSearching(true); // show "Searching…" immediately — no false "No users" flash
    const ctrl  = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${apiUrl}/users/search?q=${encodeURIComponent(normalizedSearch)}`,
          { signal: ctrl.signal, credentials: "include" }
        );
        if (!res.ok) throw new Error("Could not search users.");
        setUserMatches(await res.json());
      } catch (e) {
        if (e.name !== "AbortError") setError(e.message);
      } finally {
        setIsSearching(false);
      }
    }, 250);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [normalizedSearch]);

  // Show nothing while checking auth (prevents flash of content)
  if (!authChecked) return null;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <main className="app-shell">

      {/* ════════════ SIDEBAR ════════════ */}
      <aside className={`nav-sidebar${sidebarOpen ? "" : " nav-sidebar--collapsed"}`} aria-label="Application navigation">
        <div className="brand">
          <img src={psaLogo} alt="PSA Logo" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-title">Philippine Statistics Authority</span>
            <span className="brand-sub">Status Checklist System</span>
          </div>
        </div>

        <p className="nav-section-label">Menu</p>

        <nav className="nav-menu">
          <button
            className={`nav-item ${activePage === "dashboard" ? "nav-item--active" : ""}`}
            type="button"
            onClick={() => setActivePage("dashboard")}
          >
            <span className="nav-item-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="4" rx="1" />
                <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
                <path d="M9 14l2 2 4-4" />
              </svg>
            </span>
            Dashboard
          </button>

          <button
            className={`nav-item ${activePage === "new-user" ? "nav-item--active" : ""}`}
            type="button"
            onClick={() => setActivePage("new-user")}
          >
            <span className="nav-item-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/>
                <line x1="22" y1="11" x2="16" y2="11"/>
              </svg>
            </span>
            New User
          </button>

          <button
            className={`nav-item ${activePage === "find-user" ? "nav-item--active" : ""}`}
            type="button"
            onClick={() => setActivePage("find-user")}
          >
            <span className="nav-item-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="12" y1="18" x2="12" y2="12"/>
                <line x1="9" y1="15" x2="15" y2="15"/>
              </svg>
            </span>
            Add Files
          </button>

          <button
            className={`nav-item ${activePage === "profile" ? "nav-item--active" : ""}`}
            type="button"
            onClick={() => setActivePage("profile")}
          >
            <span className="nav-item-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </span>
            Settings
          </button>
        </nav>

        <div className="nav-footer">
          Philippine Statistics Authority<br />
          Regional Statistical Services Office II
        </div>
      </aside>

      {/* Mobile-only overlay backdrop — lets you tap outside the drawer to close it */}
      {sidebarOpen && (
        <div
          className="nav-sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ════════════ WORKSPACE ════════════ */}
      <section className="workspace">

        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              style={{
                background: "transparent", border: "none", padding: "6px 8px",
                color: "var(--text-muted)", cursor: "pointer", borderRadius: "var(--radius-sm)",
                display: "flex", alignItems: "center", flexShrink: 0,
                transition: "background 0.15s, color 0.15s",
                position: "relative", zIndex: 150,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--psa-navy)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <span className="topbar-crumb">
              PSA
              <span className="topbar-crumb-sep"> / </span>
              RSSO II
              <span className="topbar-crumb-sep"> / </span>
              <span className="topbar-crumb-current">
                {activePage === "dashboard" ? "Dashboard" : activePage === "new-user" ? "New User" : activePage === "find-user" ? "Add Files" : "Settings"}
              </span>
            </span>
          </div>
          <div className="topbar-right" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAvatar(f);
                e.target.value = "";
              }}
            />
            <div
              title="Change profile picture"
              onClick={() => setActivePage("profile")}
              style={{
                width: 36, height: 36, borderRadius: "50%",
                border: "2px solid #e0e7ef",
                background: avatarUrl ? "transparent" : "#0038a8",
                overflow: "hidden", cursor: "pointer",
                padding: 0, flexShrink: 0, position: "relative",
              }}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar"
                  style={{
                    position: "absolute", top: 0, left: 0,
                    width: "100%", height: "100%", objectFit: "cover", display: "block"
                  }}
                />
              ) : (
                <span style={{
                  position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: "0.85rem", fontWeight: 600, fontFamily: "Inter, sans-serif",
                }}>
                  {currentUser?.[0]?.toUpperCase() ?? "?"}
                </span>
              )}
            </div>
            {currentUser && (
              <span style={{ fontSize: "0.78rem", color: "#888" }}>{currentUser}</span>
            )}
            <button
              className="ghost-button"
              type="button"
              onClick={handleLogout}
              style={{ fontSize: "0.78rem" }}
            >
              Sign Out
            </button>
          </div>
        </header>

        {/* Main page content */}
        <div className="page-content">

          {activePage === "dashboard" ? (
            <Dashboard
              onOpenInAddFiles={(id, name, docItem) => {
                setSearchTerm(name);
                setOpenMemoryId(id);
                setPendingDocItem(docItem ?? "");
                setActivePage("find-user");
              }}
            />
          ) : activePage === "profile" ? (
            <>
              <div className="page-header">
                <div className="page-header-title">Settings</div>
                <div className="page-header-sub">Manage your account settings</div>
              </div>

              {/* ── Profile Picture ── */}
              <section className="panel">
                <div className="section-heading">
                  <h3 className="panel-title">
                    <span className="panel-title-dot" />
                    Profile Picture
                  </h3>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
                  <div
                    style={{ position: "relative", width: 80, height: 80, flexShrink: 0, cursor: "pointer" }}
                    onClick={() => avatarInputRef.current?.click()}
                    title="Click to change photo"
                  >
                    <div style={{
                      width: 80, height: 80, borderRadius: "50%",
                      background: avatarUrl ? "transparent" : "#0038a8",
                      border: "3px solid #e0e7ef", overflow: "hidden", position: "relative",
                    }}>
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="Profile"
                                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                      ) : (
                        <span style={{
                          position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: "#fff", fontSize: "1.8rem", fontWeight: 700,
                        }}>
                          {currentUser?.[0]?.toUpperCase() ?? "?"}
                        </span>
                      )}
                    </div>
                    {/* Camera overlay on hover */}
                    <div style={{
                      position: "absolute", inset: 0, borderRadius: "50%",
                      background: "rgba(0,0,0,0.38)", display: "flex", alignItems: "center",
                      justifyContent: "center", opacity: 0, transition: "opacity 0.15s",
                    }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                      onMouseLeave={e => e.currentTarget.style.opacity = "0"}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                        <path d="M12 15.2A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4zM9 3L7.17 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.17L15 3H9zm3 14a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>
                      </svg>
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      style={{ marginBottom: 6 }}
                    >
                      Upload Photo
                    </button>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 6 }}>
                      JPEG, PNG, WebP or GIF · Max 2 MB
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Change Password ── */}
              <section className="panel">
                <div className="section-heading">
                  <h3 className="panel-title">
                    <span className="panel-title-dot" />
                    Change Password
                  </h3>
                </div>
                <form onSubmit={changePassword} className="job-form" style={{ maxWidth: 480 }}>
                  <label style={{ gridColumn: "1 / -1" }}>
                    Current Password
                    <input
                      type="password"
                      value={pwCurrent}
                      onChange={e => setPwCurrent(e.target.value)}
                      placeholder="Enter current password"
                      autoComplete="current-password"
                    />
                  </label>
                  <label style={{ gridColumn: "1 / -1" }}>
                    New Password
                    <input
                      type="password"
                      value={pwNew}
                      onChange={e => setPwNew(e.target.value)}
                      placeholder="8+ chars, uppercase, number, symbol"
                      autoComplete="new-password"
                    />
                  </label>
                  <label style={{ gridColumn: "1 / -1" }}>
                    Confirm New Password
                    <input
                      type="password"
                      value={pwConfirm}
                      onChange={e => setPwConfirm(e.target.value)}
                      placeholder="Repeat new password"
                      autoComplete="new-password"
                    />
                  </label>
                  {pwError   && <p className="error"   style={{ gridColumn: "1 / -1" }}>{pwError}</p>}
                  {pwSuccess && <p style={{ gridColumn: "1 / -1", color: "#15803d", fontWeight: 600, fontSize: "0.9rem" }}>{pwSuccess}</p>}
                  <div className="form-actions" style={{ gridColumn: "1 / -1" }}>
                    <button type="submit" disabled={pwLoading}>
                      {pwLoading ? "Saving…" : "Change Password"}
                    </button>
                  </div>
                </form>
              </section>

              {/* ── Admin: Pending Registrations (admin123 only) ── */}
              {isAdmin && (
                <section className="panel">
                  <div className="section-heading">
                    <h3 className="panel-title">
                      <span className="panel-title-dot" />
                      Pending Registrations
                      {pendingUsers.length > 0 && (
                        <span style={{ marginLeft: 8, background: "#fee2e2", color: "#991b1b", borderRadius: 99, fontSize: "0.75rem", fontWeight: 700, padding: "2px 8px" }}>
                          {pendingUsers.length}
                        </span>
                      )}
                    </h3>
                    <button className="ghost-button" type="button" onClick={loadPendingUsers} disabled={pendingLoading}>
                      {pendingLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>

                  {pendingLoading ? (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.88rem", padding: "8px 0" }}>Loading…</div>
                  ) : pendingUsers.length === 0 ? (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.88rem", padding: "8px 0" }}>No pending registrations.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                      {pendingUsers.map(u => (
                        <div key={u.id} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 16px", background: "var(--surface-2)",
                          border: "1px solid var(--border)", borderRadius: "var(--radius)", gap: 12
                        }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}>{u.username}</div>
                            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 2 }}>
                              Registered {new Date(u.created_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button
                              type="button"
                              onClick={() => handleApprove(u.id)}
                              style={adminBtn("green")}
                              onMouseEnter={e => e.currentTarget.style.opacity = "0.82"}
                              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReject(u.id, u.username)}
                              style={adminBtn("red")}
                              onMouseEnter={e => e.currentTarget.style.opacity = "0.82"}
                              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* ── Admin: All Users ── */}
              {isAdmin && (
                <section className="panel">
                  <div className="section-heading">
                    <h3 className="panel-title">
                      <span className="panel-title-dot" />
                      System Users
                    </h3>
                    <button className="ghost-button" type="button" onClick={loadAllUsers} disabled={allUsersLoading}>
                      {allUsersLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>

                  {allUsersLoading ? (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.88rem", padding: "8px 0" }}>Loading…</div>
                  ) : allUsers.length === 0 ? (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.88rem", padding: "8px 0" }}>No users found.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                      {allUsers.map(u => {
                        const statusColor = u.status === "active" ? { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0" }
                          : u.status === "blocked" ? { bg: "#fff1f0", text: "#b91c1c", border: "#fecaca" }
                          : { bg: "#fffbef", text: "#92400e", border: "#fde68a" };
                        return (
                          <div key={u.id} style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "11px 16px", background: "var(--surface-2)",
                            border: "1px solid var(--border)", borderRadius: "var(--radius)", gap: 12
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                              <div style={{
                                width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                                background: "#0038a8", position: "relative", overflow: "hidden",
                              }}>
                                <span style={{
                                  position: "absolute", inset: 0,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  color: "#fff", fontSize: "0.86rem", fontWeight: 700,
                                }}>
                                  {u.username[0].toUpperCase()}
                                </span>
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>{u.username}</div>
                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 1 }}>
                                  {new Date(u.created_at).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" })}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                              {u.status === "active" && (
                                <button
                                  type="button"
                                  title="Block user"
                                  onClick={() => { if (window.confirm(`Block "${u.username}"?\n\nThis will prevent them from logging in.`)) handleBlock(u.id); }}
                                  style={{ ...adminBtn("red"), width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = "0.82"}
                                  onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                  </svg>
                                </button>
                              )}
                              {u.status === "blocked" && (
                                <button
                                  type="button"
                                  title="Unblock user"
                                  onClick={() => handleUnblock(u.id)}
                                  style={{ ...adminBtn("green"), width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = "0.82"}
                                  onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                                  </svg>
                                </button>
                              )}
                              <button
                                type="button"
                                title="Delete account"
                                onClick={() => handleDeleteSystemUser(u.id, u.username)}
                                style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-sm)", background: "#fee2e2", color: "#991b1b", border: "1.5px solid #fecaca", cursor: "pointer", transition: "background 0.12s", flexShrink: 0 }}
                                onMouseEnter={e => e.currentTarget.style.background = "#fecaca"}
                                onMouseLeave={e => e.currentTarget.style.background = "#fee2e2"}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6"/>
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                  <path d="M10 11v6"/><path d="M14 11v6"/>
                                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                                </svg>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </>
          ) : activePage === "new-user" ? (
            <>
              <div className="page-header">
                <div className="page-header-title">New User</div>
                <div className="page-header-sub">Register a new employee to the status checklist system</div>
              </div>

              {/* ── Add / Edit user panel ── */}
              <section className="panel" id="add-user">
                <div className="section-heading">
                  <h3 className="panel-title">
                    <span className="panel-title-dot" />
                    {editingMemoryId ? "Edit User" : "Add New User"}
                  </h3>
                  {editingMemoryId && (
                    <button className="ghost-button" type="button" onClick={resetForm}>
                      Cancel Edit
                    </button>
                  )}
                </div>

                <form onSubmit={submitUser} className="job-form" id="user-form">
                  <label style={{ gridColumn: "1 / -1" }}>
                    Full Name
                    <input
                      id="input-full-name"
                      value={personName}
                      onChange={(e) => setPersonName(e.target.value)}
                      placeholder="e.g. Juan Dela Cruz"
                      required
                    />
                  </label>

                  <div className="field-group">
                    <label>
                      Assign Position / New Position
                      <input
                        id="input-position"
                        value={position}
                        onChange={(e) => setPosition(e.target.value)}
                        placeholder="e.g. Administrative Officer IV"
                        required
                      />
                    </label>
                    <label>
                      Saved Positions
                      <CustomSelect
                        id="select-position"
                        value=""
                        onChange={val => setPosition(val)}
                        placeholder="Select saved…"
                        options={savedPositions.map(p => ({ value: p, label: p }))}
                      />
                    </label>
                  </div>

                  <div className="field-group">
                    <label>
                      Office / Division
                      <input
                        id="input-office"
                        value={officeDivision}
                        onChange={(e) => setOfficeDivision(e.target.value)}
                        placeholder="e.g. RSSO II / CRASD"
                      />
                    </label>
                    <label>
                      Saved Offices
                      <CustomSelect
                        id="select-office"
                        value=""
                        onChange={val => setOfficeDivision(val)}
                        placeholder="Select saved…"
                        options={savedOfficeDivisions.map(o => ({ value: o, label: o }))}
                      />
                    </label>
                  </div>

                  <div className="form-actions">
                    <button type="submit" id="save-user-btn" disabled={isSubmitting}>
                      {isSubmitting ? "Saving…" : editingMemoryId ? "Save Changes" : "Save User"}
                    </button>
                    {editingMemoryId && (
                      <button className="ghost-button" type="button" onClick={resetForm}>
                        Cancel
                      </button>
                    )}
                  </div>
                </form>

                {error && <p className="error">{error}</p>}
              </section>

              {/* ── Add Office/Division and Position (2nd assignment, optional) ── */}
              <section className="panel" id="add-office-position">
                <div className="section-heading">
                  <h3 className="panel-title">
                    <span className="panel-title-dot" />
                    Add Office/Division and Position
                  </h3>
                </div>

                <div className="job-form">
                  <div className="field-group">
                    <label>
                      Assign Position / New Position
                      <input
                        id="input-position-2"
                        value={position2}
                        onChange={(e) => setPosition2(e.target.value)}
                        placeholder="e.g. Administrative Officer IV"
                      />
                    </label>
                    <label>
                      Saved Positions
                      <CustomSelect
                        id="select-position-2"
                        value=""
                        onChange={val => setPosition2(val)}
                        placeholder="Select saved…"
                        options={savedPositions2.map(p => ({ value: p, label: p }))}
                      />
                    </label>
                  </div>

                  <div className="field-group">
                    <label>
                      Office / Division
                      <input
                        id="input-office-2"
                        value={officeDivision2}
                        onChange={(e) => setOfficeDivision2(e.target.value)}
                        placeholder="e.g. RSSO II / CRASD"
                      />
                    </label>
                    <label>
                      Saved Offices
                      <CustomSelect
                        id="select-office-2"
                        value=""
                        onChange={val => setOfficeDivision2(val)}
                        placeholder="Select saved…"
                        options={savedOfficeDivisions2.map(o => ({ value: o, label: o }))}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
                  <button type="button" className="ghost-button" onClick={saveSecondAssignment}>
                    Add
                  </button>
                  <button
                    type="button"
                    title="Remove this additional assignment"
                    onClick={clearSecondAssignment}
                    style={{
                      width: 36, height: 36, padding: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: "var(--radius-sm)", background: "#fee2e2", color: "#991b1b",
                      border: "1.5px solid #fecaca", cursor: "pointer", flexShrink: 0,
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                  {!editingMemoryId && (
                    <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      New employee: this saves together with Save User above. Editing an existing employee: use Add/✕ here directly.
                    </span>
                  )}
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="page-header">
                <div className="page-header-title">Add Files</div>
                <div className="page-header-sub">Search employees and upload their requirement documents</div>
              </div>

              {/* ── Find user search ── */}
              <section className="panel" id="find-user">
                <div className="section-heading">
                  <h3 className="panel-title">
                    <span className="panel-title-dot" />
                    Add Files
                  </h3>
                </div>
                <label>
                  Search keyword
                  <div style={{ position: "relative" }}>
                    <svg
                      style={{
                        position: "absolute", left: "12px", top: "50%",
                        transform: "translateY(-50%)", width: "16px", height: "16px",
                        fill: "none", stroke: "#8fa8c8", strokeWidth: "2",
                        strokeLinecap: "round", strokeLinejoin: "round", pointerEvents: "none"
                      }}
                      viewBox="0 0 24 24"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <line x1="16.5" y1="16.5" x2="22" y2="22" />
                    </svg>
                    <input
                      id="find-user-search"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Type a name to search…"
                      style={{ paddingLeft: "36px" }}
                    />
                  </div>
                </label>
              </section>

              {/* ── Saved Users — top 10 ranked by search frequency ── */}
              <div>
                <div className="users-header">
                  <h2>Saved Users</h2>
                </div>

                <div className="data-column" aria-label="Saved users">
                  {normalizedSearch && isSearching ? (
                    <div className="empty">Searching…</div>
                  ) : normalizedSearch && userMatches.length === 0 ? (
                    <div className="empty">No users match your search.</div>
                  ) : (normalizedSearch ? userMatches : topUsers).length === 0 ? (
                    <div className="empty">No saved users yet.</div>
                  ) : (
                    (normalizedSearch ? userMatches : topUsers).map((memory) => (
                      <UserCard
                        key={memory.id}
                        memory={memory}
                        isOpen={openMemoryId === memory.id}
                        uploadedFiles={openMemoryId === memory.id ? uploadedFiles : EMPTY_FILES}
                        initialDocItem={openMemoryId === memory.id ? pendingDocItem : ""}
                        onToggle={handleToggle}
                        onEdit={handleEdit}
                        onUpload={uploadFile}
                        onDownload={downloadFile}
                        onDelete={deleteFile}
                        onDeleteUser={deleteUser}
                      />
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
