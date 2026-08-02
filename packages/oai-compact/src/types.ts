import type { CompactionEntry, CompactionResult } from "@earendil-works/pi-coding-agent";

export const NATIVE_COMPACTION_STRATEGY = "openai-native-compact-v1";
export const NATIVE_COMPACTION_SHIM_SUMMARY = "[OpenAI native compaction checkpoint]";

export type NativeCompactionRequestMeta = {
	tokensBefore?: number;
	previousSummaryPresent?: boolean;
};

export type NativeCompactionDetails = {
	strategy: typeof NATIVE_COMPACTION_STRATEGY;
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
	compactedWindow: Record<string, unknown>[];
	compactResponseId?: string;
	portableSummary?: boolean;
	portableSummaryResponseId?: string;
	createdAt: string;
	requestMeta?: NativeCompactionRequestMeta;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function cloneStructuredValue(value: unknown): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}

	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			clone[key] = cloneStructuredValue(nested);
		}
		return clone;
	}

	throw new Error(`Unsupported structured value: ${typeof value}`);
}

function isStructuredValue(value: unknown): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isStructuredValue);
	}

	if (isRecord(value)) {
		return Object.values(value).every(isStructuredValue);
	}

	return false;
}

function isCompactedWindowItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && Object.values(value).every(isStructuredValue);
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
	return (
		isRecord(value) &&
		value.strategy === NATIVE_COMPACTION_STRATEGY &&
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.api) &&
		isNonEmptyString(value.model) &&
		isNonEmptyString(value.baseUrl) &&
		Array.isArray(value.compactedWindow) &&
		value.compactedWindow.every(isCompactedWindowItem) &&
		isNonEmptyString(value.createdAt) &&
		(value.compactResponseId === undefined || isNonEmptyString(value.compactResponseId)) &&
		(value.portableSummary === undefined || typeof value.portableSummary === "boolean") &&
		(value.portableSummaryResponseId === undefined || isNonEmptyString(value.portableSummaryResponseId))
	);
}

export function isNativeCompactionEntry(value: unknown): value is NativeCompactionEntry {
	return isRecord(value) && value.type === "compaction" && isNativeCompactionDetails(value.details);
}

export function createNativeCompactionDetails(input: {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
	compactedWindow: unknown[];
	compactResponseId?: string;
	portableSummary?: boolean;
	portableSummaryResponseId?: string;
	createdAt?: string;
	requestMeta?: NativeCompactionRequestMeta;
}): NativeCompactionDetails {
	return {
		strategy: NATIVE_COMPACTION_STRATEGY,
		provider: input.provider.trim(),
		api: input.api.trim(),
		model: input.model.trim(),
		baseUrl: input.baseUrl.trim(),
		compactedWindow: input.compactedWindow.map((item) => cloneStructuredValue(item) as Record<string, unknown>),
		compactResponseId: isNonEmptyString(input.compactResponseId) ? input.compactResponseId.trim() : undefined,
		portableSummary: input.portableSummary,
		portableSummaryResponseId: isNonEmptyString(input.portableSummaryResponseId)
			? input.portableSummaryResponseId.trim()
			: undefined,
		createdAt: isNonEmptyString(input.createdAt) ? input.createdAt.trim() : new Date().toISOString(),
		requestMeta: input.requestMeta
			? {
				...(input.requestMeta.tokensBefore !== undefined ? { tokensBefore: input.requestMeta.tokensBefore } : {}),
				...(input.requestMeta.previousSummaryPresent !== undefined
					? { previousSummaryPresent: input.requestMeta.previousSummaryPresent }
					: {}),
			}
			: undefined,
	};
}

export function createNativeCompactionShimResult(input: {
	firstKeptEntryId: string;
	tokensBefore: number;
	details: NativeCompactionDetails;
	summary?: string;
}): CompactionResult<NativeCompactionDetails> {
	return {
		summary: input.summary?.trim() || NATIVE_COMPACTION_SHIM_SUMMARY,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details: input.details,
	};
}
