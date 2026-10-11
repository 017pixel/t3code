/**
 * Pi's server entry: the adapter driver used by replay tests and the fixture
 * recorder. The server loads the driver from `./server/driver`.
 *
 * @module provider-pi/server
 */
export { PI_PROVIDER, PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./server/adapter.ts";
