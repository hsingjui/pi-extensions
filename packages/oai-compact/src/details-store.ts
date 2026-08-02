import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isNativeCompactionEntry, type NativeCompactionEntry } from "./types.js";

export type LatestNativeCompactionResolution =
	| {
			ok: true;
			entry: NativeCompactionEntry;
			index: number;
	  }
	| {
			ok: false;
			reason: "no-compaction" | "latest-compaction-not-native";
	  };

export function resolveLatestNativeCompactionEntry(
	entries: readonly SessionEntry[],
): LatestNativeCompactionResolution {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as SessionEntry | undefined;
		if (!entry || typeof entry !== "object" || !("type" in entry)) {
			continue;
		}

		if (isNativeCompactionEntry(entry)) {
			return {
				ok: true,
				entry,
				index,
			};
		}

		if ((entry as { type?: unknown }).type === "compaction") {
			return {
				ok: false,
				reason: "latest-compaction-not-native",
			};
		}
	}

	return {
		ok: false,
		reason: "no-compaction",
	};
}
