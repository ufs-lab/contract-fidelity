// Stands in for a generated @acme client. The `@acme` path segment
// is what marks these declarations as contract, so the directory name matters.

export declare const Scope: {
    readonly HOUSE: "HOUSE";
    readonly CLIENT: "CLIENT";
    readonly GROUP: "GROUP";
};
export type Scope = typeof Scope[keyof typeof Scope];

export interface Movement {
    /**
     * Amount in minor units (must be > 0). Full int64 width.
     */
    'amount': number;
    /**
     * Rows staged by outcome. Counts are non-negative.
     */
    'staged': number;
    /**
     * Site identifier (1-31, per REQ-004)
     */
    'site_id': number;
    'scope': Scope;
    'label': string;
    'tags': Array<string>;
    /**
     * Legs of the movement; at least one is required.
     */
    'legs': Array<string>;
    /**
     * Canonical exports this event lacks. Non-empty means the event is excluded
     * from matching until re-emitted.
     */
    'missing_exports': Array<string>;
}

/**
 * Stands in for the class-based generator template (typescript-node), which
 * Lob's and Klaviyo's SDKs both use. Recognising only interfaces made the scan
 * read no guarantees at all from repos like those.
 */
export declare class MovementModel {
    /**
     * Amount in minor units (must be > 0).
     */
    'classAmount': number;
    /**
     * Operators for the filter.  e.g. "between 10 and 20 days ago"
     */
    'classOperator': Scope;
    /** A method is not a data field and carries no guarantee. */
    describe(): string;
}
