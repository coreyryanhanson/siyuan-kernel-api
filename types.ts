/**
 * Exported surface types for SiYuanKernelClient.
 * Breadth policy: type only the fields the extension consumes and pass unknown
 * fields through via a `Record<string, unknown>` intersection — no full Go
 * model transcription. Widen when a consumer needs more, not before. Exception:
 * fields the kernel provably always sets on every endpoint a type serves may
 * be typed before a consumer demands it.
 */

/** Row of `/api/notebook/lsNotebooks` (and the single-row create envelopes). */
export type NotebookInfo = {
	id: string;
	name: string;
	encrypted: boolean;
	unlocked: boolean;
	closed: boolean;
	/**
	 * Top-level doc count. Ships since kernel v3.7.3 (older kernels omit the
	 * key — `undefined` at runtime); even then it is 0 unless the workspace's
	 * box-doc setting is on and the notebook is open (see `listNotebooks()`'s
	 * `boxDocEnabled`), and 0 for an empty or unreadable notebook. Single-row
	 * returns (createNotebook/createEncryptedNotebook) carry no envelope flag —
	 * interpret only when the workspace flag is known on.
	 */
	subFileCount?: number;
} & Record<string, unknown>;

/** `data` of `/api/notebook/lsNotebooks`. */
export type NotebookList = {
	/**
	 * Whether the workspace's box-doc setting is on — the gate that makes
	 * `subFileCount` meaningful. Ships since kernel v3.7.3; older kernels omit
	 * the key entirely (`undefined` at runtime = off, since box-doc did not
	 * exist before v3.7.3). Read it with a truthy check, not `=== false`, which
	 * `undefined` would misread as on.
	 */
	boxDocEnabled?: boolean;
	notebooks: NotebookInfo[];
} & Record<string, unknown>;

/** Row of `/api/search/fullTextSearchBlock` and `/api/search/listInvalidBlockRefs`. */
export type SearchBlock = {
	id: string;
	rootID: string;
	box: string;
	hPath: string;
	updated: string;
	/** Always set by the kernel (the row is a full model.Block with no omitempty). */
	content: string;
} & Record<string, unknown>;

/** `data` of `/api/search/fullTextSearchBlock` and `/api/search/listInvalidBlockRefs` (the counts feed caller-side fan-out merges). */
export type SearchResult = {
	blocks: SearchBlock[];
	matchedBlockCount: number;
	matchedRootCount: number;
	pageCount: number;
} & Record<string, unknown>;

/** `data` of `/api/notebook/getEncryptedNotebookStatus`. */
export type EncryptedNotebookStatus = {
	enabled: boolean;
	/** Lifecycle states of the workspace's encrypted-notebook feature. */
	state: "Disabled" | "Enabled" | "RecoveryRequired";
	count: number;
	boxes: EncryptedBoxStatus[];
} & Record<string, unknown>;

/** Row of `EncryptedNotebookStatus.boxes`. */
export type EncryptedBoxStatus = {
	id: string;
	/** Empty unless the box is currently mounted/unlocked — resolve names through `listNotebooks()`. */
	name: string;
	unlocked: boolean;
	/** Per-box lock states. */
	state: "Locked" | "Unlocking" | "Unlocked" | "Locking" | "Error";
} & Record<string, unknown>;

/** Row of `/api/block/getChildBlocks`. */
export type ChildBlock = Record<string, unknown>;

/**
 * One operation of a `/api/transactions` batch (kernel
 * `TransactionOperation`). Only `action` is typed: the kernel accepts many
 * optional fields (anchors, attribute-view fields, …) that this client never
 * interprets — they pass through untouched. Op `data` rules (inline block
 * DOM, never markdown; the kernel type-asserts it unguarded) — see
 * `transact()`.
 */
export type TransactionOperation = { action: string } & Record<string, unknown>;

/**
 * One element of `transact()`'s `transactions` array — the kernel's own
 * `Transaction` (its request element and post-commit echo are the same
 * type, so `transact()` returns an array of these). The kernel overwrites
 * `timestamp` from the request's `reqId`; it never fills `undoOperations` —
 * a batch enters the editor's global undo log only when the caller supplies
 * them, and they are then replayed verbatim.
 */
export type Transaction = {
	doOperations: TransactionOperation[];
	/** Opt-in: caller-supplied undo ops enter the editor's global undo log and are replayed verbatim; the kernel never fills them itself. */
	undoOperations?: TransactionOperation[];
} & Record<string, unknown>;

/** `data` of `/api/export/exportMdContent`. */
export type ExportMarkdownResult = {
	hPath: string;
	content: string;
} & Record<string, unknown>;

/**
 * `data` of the single-op block-write endpoints
 * (insert/append/update/delete) — a narrower echo than `transact()`'s,
 * which returns the kernel's full `Transaction`. The kernel sets
 * `ret.Data` there and returns `null` for `moveBlock`. Extracting
 * `data[0].doOperations[0].id` stays in the extension.
 */
export type BlockTransaction = {
	doOperations: ({ id: string } & Record<string, unknown>)[];
} & Record<string, unknown>;
