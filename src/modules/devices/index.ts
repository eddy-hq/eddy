// Public barrel for the devices module.
//
// A device row is a push identity: which user owns it, the APNs token, and
// which of Apple's environments that token is valid in. The notifications
// module reads it through `listPushDevices` and prunes dead tokens through
// `forgetDevice`; nothing else touches the table.

export { devicesRouter } from './router';
export {
  upsertDevice,
  deleteDevice,
  forgetDevice,
  listPushDevices,
  tokenFingerprint,
  APNS_ENVIRONMENTS,
  DEVICE_TYPES,
} from './registry';
export type { ApnsEnvironment, DeviceRegistration, PushDevice } from './registry';
