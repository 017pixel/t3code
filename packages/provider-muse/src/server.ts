/**
 * Muse Code's server entry: the adapter factory the replay testkit and
 * fixture recorder build on. The server loads the driver from `./server/driver`.
 *
 * @module provider-muse/server
 */
export { makeMuseAdapterV2, type MuseAdapterV2Options } from "./server/adapter.ts";
