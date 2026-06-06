/** Minimalistic caching utility. */
export class Cached<T> {
	private cachedValue: T | undefined;

	constructor(private readonly compute: () => T) {}

	get value(): T {
		if (this.cachedValue === undefined) {	// More strict than truthy
			this.cachedValue = this.compute();
		}
		return this.cachedValue;
	}

	set value(value: T) {
		this.cachedValue = value;
	}

	get hasValue(): boolean {
		return this.cachedValue !== undefined;
	}

	clear() {
		this.cachedValue = undefined;
	}
}
