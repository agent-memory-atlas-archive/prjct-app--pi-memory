import { KEYRING_ACCOUNT, KEYRING_SERVICE, keyringStoreFromEntries, type SecretStore } from '@prjct.app/pi-tui-kit';

/**
 * The global TypeSafe credential is shared with every other prjct extension,
 * so resolution and the stored record format live in pi-tui-kit. Only the
 * native entry is built here. pi-memory has no legacy entry of its own: it has
 * never stored this key before, and inventing one would only give the
 * migration path something wrong to find.
 */
export const openSecretStore = async (): Promise<SecretStore> => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return keyringStoreFromEntries(new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT));
};
