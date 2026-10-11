/**
 * ACP Registry's server entry: the adapter driver the server registers. The
 * server loads the driver from `./server/driver` and the managed-binary
 * directories from `./server/AcpRegistrySupport`.
 *
 * The catalog and runtime coordinator are services; import them from
 * `./server/AcpRegistrySupport` and `./server/AcpRegistryRuntimeCoordinator`.
 *
 * @module provider-acp-registry/server
 */
export {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "./server/adapter.ts";
