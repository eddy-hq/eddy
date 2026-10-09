// Public barrel for the devices module.
//
// A device row is an enrolled device (ADR-0016): who owns it, the hash of the
// credential it presents, and its push identity once it has one. Every API
// router reads the acting user through `requireDevice` + `actorOf`; the
// notifications module reads push identities through `listPushDevices` and
// prunes dead tokens through `forgetDevice`.

export { devicesRouter } from './router';
export {
  requireDevice,
  requireParentDevice,
  actorOf,
  deviceIdOf,
  requireParentActor,
  bindActor,
  claimMatchesActor,
  CREDENTIAL_COOKIE,
} from './credential';
export { createInvite, redeemInvite, INVITE_HANDLER } from './enrolment';
export type { Enrolment } from './enrolment';
export {
  registerPush,
  deleteDevice,
  forgetDevice,
  revokeDevice,
  listDevices,
  listPushDevices,
  tokenFingerprint,
  APNS_ENVIRONMENTS,
  DEVICE_TYPES,
} from './registry';
export type { ApnsEnvironment, PushRegistration, PushDevice, DeviceSummary } from './registry';
