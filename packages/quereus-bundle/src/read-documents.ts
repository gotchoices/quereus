import { Composer, Parser } from 'yaml';
import type { Document } from 'yaml';
import { MisuseError } from '@quereus/quereus';
import { PARSE_OPTIONS } from './value-codec.js';

/** A 1-based position in the bundle text. */
export interface TextPosition {
	line: number;
	column: number;
}

/** One YAML document of a bundle, as the reader yields it. */
export interface BundleDocument {
	/** Position of the document in the stream, the header being 0. */
	index: number;
	document: Document.Parsed;
	/** The document's first YAML error, when it has any. Its rows cannot be trusted. */
	error?: { message: string } & Partial<TextPosition>;
	/** The position of a text offset in this document. Valid until the next document is requested. */
	locate(offset: number): TextPosition;
}

/** Where a bundle's text comes from: the whole text, or its chunks in order. */
export type BundleSource = string | Iterable<string> | AsyncIterable<string>;

/**
 * Yields the YAML documents of `source` one at a time, so memory stays bounded by the
 * largest document rather than the file. Chunks may split the text anywhere, including
 * inside a line ({@link wholeLines}). Documents are composed with the codec's parse
 * options, so ints read as `bigint` and `!!binary` uses the package's own tag.
 *
 * @throws MisuseError when a chunk is not a string (a byte stream that was not decoded).
 */
export async function* readDocuments(source: BundleSource): AsyncGenerator<BundleDocument> {
	const lines = new StreamLineCounter();
	const parser = new Parser(lines.addNewLine);
	const composer = new Composer(PARSE_OPTIONS);
	let index = 0;

	async function* emit(documents: Iterable<Document.Parsed>): AsyncGenerator<BundleDocument> {
		for (const document of documents) {
			yield { index: index++, document, error: firstError(document, lines), locate: offset => lines.linePos(offset) };
			lines.discardBefore(document.range[2]);
		}
	}

	for await (const text of wholeLines(source)) {
		for (const token of parser.parse(text, true)) yield* emit(composer.next(token));
	}
	for (const token of parser.parse('', false)) yield* emit(composer.next(token));
	yield* emit(composer.end());
}

/**
 * Regroups `source`'s chunks so each piece ends at a line end, except the text after the
 * file's last newline, which comes last. The `yaml` library's incremental lexer (2.9.0)
 * misreads a chunk boundary inside a line's indentation: `tables:\n ` then
 * ` - schema: main\n    table: t` composes as a nested compact mapping, which is the
 * exporter's header shape. Boundaries at line ends read correctly. The parts of a line
 * that spans chunks are joined once, so a long line costs its length, not chunks × length.
 *
 * @throws MisuseError when a chunk is not a string.
 */
async function* wholeLines(source: BundleSource): AsyncGenerator<string> {
	let pending: string[] = [];
	for await (const chunk of chunksOf(source)) {
		if (typeof chunk !== 'string') {
			throw new MisuseError(`A bundle source must yield strings, got ${describe(chunk)}; decode bytes as UTF-8 first`);
		}
		const end = chunk.lastIndexOf('\n') + 1;
		if (end === 0) {
			// An empty chunk would make the parser report a second line start at offset 0.
			if (chunk.length > 0) pending.push(chunk);
			continue;
		}
		pending.push(chunk.slice(0, end));
		yield pending.join('');
		pending = end < chunk.length ? [chunk.slice(end)] : [];
	}
	if (pending.length > 0) yield pending.join('');
}

function chunksOf(source: BundleSource): Iterable<unknown> | AsyncIterable<unknown> {
	return typeof source === 'string' ? [source] : source;
}

function firstError(document: Document.Parsed, lines: StreamLineCounter): BundleDocument['error'] {
	const error = document.errors[0];
	if (!error) return undefined;
	return { message: error.message, ...lines.linePos(error.pos[0]) };
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'object') return value.constructor?.name ?? 'object';
	return typeof value;
}

/**
 * The `yaml` library's `LineCounter` keeps every line start of the stream, which for a
 * large bundle is one number per row. This one forgets the lines of documents already
 * handed out, keeping only the line number they add up to.
 */
class StreamLineCounter {
	/** Line number of `starts[0]`. */
	private firstLine = 1;
	/** Offsets of the line starts still kept, ascending. */
	private starts: number[] = [];

	readonly addNewLine = (offset: number): void => {
		this.starts.push(offset);
	};

	/** Forgets every line that ends at or before `offset`. */
	discardBefore(offset: number): void {
		const keep = this.lineIndex(offset);
		if (keep <= 0) return;
		this.starts = this.starts.slice(keep);
		this.firstLine += keep;
	}

	/** 1-based line and column of `offset`. An offset before the kept lines reports the first kept line. */
	linePos(offset: number): TextPosition {
		const i = Math.max(this.lineIndex(offset), 0);
		const start = this.starts[i] ?? 0;
		return { line: this.firstLine + i, column: Math.max(offset - start, 0) + 1 };
	}

	/** Index of the last kept line start at or before `offset`, or -1. */
	private lineIndex(offset: number): number {
		let low = 0;
		let high = this.starts.length - 1;
		let found = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (this.starts[mid] <= offset) {
				found = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return found;
	}
}
