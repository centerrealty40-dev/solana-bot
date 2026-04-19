import type { Hypothesis } from '../hypotheses/base.js';
import { H1ConfirmationGate } from '../hypotheses/h1-confirmation-gate.js';
import { H2WalletClustering } from '../hypotheses/h2-wallet-clustering.js';
import { H3DevSignal } from '../hypotheses/h3-dev-signal.js';
import { H4PreListing } from '../hypotheses/h4-pre-listing.js';
import { H5NegativeCopy } from '../hypotheses/h5-negative-copy.js';
import { H6SnipeThenHold } from '../hypotheses/h6-snipe-then-hold.js';
import { H7ConfluenceGate } from '../hypotheses/h7-confluence-gate.js';

/**
 * Single source of truth for all available hypotheses. Disable any by removing from the array.
 */
export function buildHypotheses(): Hypothesis[] {
  return [
    new H1ConfirmationGate(),
    new H2WalletClustering(),
    new H3DevSignal(),
    new H4PreListing(),
    new H5NegativeCopy(),
    new H6SnipeThenHold(),
    new H7ConfluenceGate(),
  ];
}

/** Lightweight catalog (id + describe) for scripts that don't want to instantiate hypotheses heavily. */
export const ALL_HYPOTHESES = buildHypotheses().map((h) => ({ id: h.id, describe: h.describe() }));
