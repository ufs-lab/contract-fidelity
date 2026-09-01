// Stands in for a generated @acme client in a project that keeps its code
// somewhere other than `src`. The `@acme` path segment marks it as contract.

export interface Movement {
    /**
     * Amount in minor units (must be > 0). Full int64 width.
     */
    'amount': number;
    'label': string;
}

/**
 * The class template (typescript-node). The audit must see these too.
 */
export declare class MovementModel {
    /**
     * Rows staged by outcome. Counts are non-negative.
     */
    'staged': number;
    /** A method is not a data field and carries no guarantee. */
    describe(): string;
}
