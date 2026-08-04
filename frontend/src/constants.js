// Employment status drives which requirement documents actually apply to a
// person. Stored on the employee record; the per-status required set is a
// separate change still to come.
export const EMPLOYMENT_STATUSES = [
  "Permanent",
  "Casual",
  "Contractual",
  "Contract of Service (COS)",
  "Job Order",
];

// Whether the person is still with the agency. Separated staff should not drag
// down completion figures once the dashboard reads this.
export const RECORD_STATUSES = [
  "Active",
  "Resigned",
  "Retired",
  "Transferred",
];

export const REQUIREMENT_DOCUMENTS = [
  { item: "A", name: "Appointment (CS FORM 33)" },
  { item: "B", name: "Oath of Office" },
  { item: "C", name: "Certificate of Assumption to Duty" },
  { item: "D", name: "Position Description Form (PDF)" },
  { item: "E", name: "Personal Data Sheet (PDS)" },
  { item: "F", name: "Notice of Salary Adjustment (NOSA) / Notice of Salary Increment (NOSI)" },
  { item: "G", name: "Certificate of Eligibility" },
  { item: "H", name: "Transcript of Records / Diploma" },
  { item: "I", name: "Service Record" },
  { item: "J", name: "Certificate of Leave Balance" },
  { item: "K", name: "Statement of Assets and Liabilities (SALN)" },
  { item: "L", name: "Marriage Contract" },
  { item: "M", name: "Medical Certificate" },
  { item: "N", name: "Clearances" },
  { item: "O", name: "Special Orders (SO) / Memorandum" },
  { item: "P", name: "Certificate of Training" },
  { item: "Q", name: "Others" },
];
