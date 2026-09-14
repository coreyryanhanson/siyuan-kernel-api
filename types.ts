/**
 * Exported surface types for SiYuanKernelClient.
 * Breadth policy: type only the fields the extension consumes and pass unknown
 * fields through via a `Record<string, unknown>` intersection — no full Go
 * model transcription. Widen when a consumer needs more, not before. Exception:
 * fields the kernel provably always sets on every endpoint a type serves may
 * be typed before a consumer demands it.
 */

/** Row of `/api/notebook/lsNotebooks`. `boxDocEnabled` is intentionally not surfaced (no consumer). */
export type NotebookInfo = {
	id: string;
	name: string;
	encrypted: boolean;
	unlocked: boolean;
	closed: boolean;
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
	/** Lifecycle states of the workspace's encrypted-notebook feature (v3.8.3 kernel values). */
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
	/** Per-box lock states (v3.8.3 kernel values). */
	state: "Locked" | "Unlocking" | "Unlocked" | "Locking" | "Error";
} & Record<string, unknown>;

/** Row of `/api/block/getChildBlocks`. */
export type ChildBlock = Record<string, unknown>;

/** `data` of `/api/export/exportMdContent`. */
export type ExportMarkdownResult = {
	hPath: string;
	content: string;
} & Record<string, unknown>;

/**
 * `data` of the block-write endpoints (insert/append/update/delete). The
 * kernel only sets `ret.Data` on these four — `moveBlock` returns `null`.
 * Extracting `data[0].doOperations[0].id` stays in the extension.
 */
export type BlockTransaction = {
	doOperations: ({ id: string } & Record<string, unknown>)[];
} & Record<string, unknown>;
