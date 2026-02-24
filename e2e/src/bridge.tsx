import { useEffect, useRef } from "react";
import {
  useSyncDb,
  useSync,
  useSpaces,
  usePendingInvitations,
  useActiveSpaces,
  useFileStore,
  useSpaceManager,
  usePresenceManager,
  useEventManager,
} from "betterbase/sync/react";
import {
  moveToSpace as moveToSpaceFn,
  bulkMoveToSpace as bulkMoveToSpaceFn,
  FileStore,
  FilesClient,
  type SpaceRecord,
  type SpaceFields,
  type Member,
} from "betterbase/sync";
import { encodeDIDKeyFromJwk } from "betterbase/crypto";
import { items, notes } from "./collections";
import type { CollectionDef } from "betterbase/db";

// ---------------------------------------------------------------------------
// Type declarations for window.__test
// ---------------------------------------------------------------------------

export interface TestAPI {
  // Auth state
  getAuthState(): {
    isAuthenticated: boolean;
    personalSpaceId: string | null;
    hasEncryptionKey: boolean;
    hasKeypair: boolean;
  };
  getSelfDID(): Promise<string | null>;

  // DB CRUD
  put(
    collection: string,
    data: Record<string, unknown>,
    options?: { space?: string },
  ): Promise<string>;
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;
  query(collection: string, query?: object): Promise<Record<string, unknown>[]>;
  patch(collection: string, data: Record<string, unknown>): Promise<void>;
  del(collection: string, id: string): Promise<void>;

  // Sync
  sync(): Promise<void>;
  getSyncStatus(): { phase: string; syncing: boolean; error: string | null };
  waitForSync(timeoutMs?: number): Promise<void>;

  // Spaces
  createSpace(): Promise<string>;
  invite(
    spaceId: string,
    handle: string,
    meta?: { role?: string; spaceName?: string },
  ): Promise<void>;
  getInvitations(): Promise<
    Array<{
      id: string;
      spaceId: string;
      _spaceId: string;
      invitedBy?: string;
      name?: string;
    }>
  >;
  acceptInvitation(recordId: string): Promise<void>;
  declineInvitation(recordId: string): Promise<void>;
  getActiveSpaces(): Promise<
    Array<{ id: string; spaceId: string; _spaceId: string; status: string }>
  >;
  getMembers(spaceId: string): Promise<Member[]>;
  removeMember(spaceId: string, memberDID: string): Promise<void>;
  checkInvitations(): Promise<number>;

  // Files
  uploadFile(fileId: string, data: number[], recordId: string, spaceId?: string): Promise<void>;
  downloadFile(fileId: string, spaceId?: string): Promise<number[]>;

  // Space operations
  userExists(handle: string): Promise<boolean>;
  moveToSpace(collection: string, recordId: string, targetSpaceId: string): Promise<string>;
  bulkMoveToSpace(
    collection: string,
    recordIds: string[],
    targetSpaceId: string,
  ): Promise<string[]>;

  // Presence
  setPresence(spaceId: string, data: unknown): void;
  clearPresence(spaceId: string): void;
  getPeers(spaceId: string): Array<{ peer: string; data: unknown }>;
  getPeerCount(spaceId: string): number;

  // Ephemeral events
  sendEvent(spaceId: string, name: string, data: unknown): void;
  subscribeToEvent(spaceId: string, name: string): string;
  getReceivedEvents(key: string): Array<{ data: unknown; peer: string }>;
  unsubscribeEvent(key: string): void;

  // Epoch rotation
  rotateSpaceKey(spaceId: string): Promise<void>;
  getSpaceEpoch(spaceId: string): number | null;

  // Utility
  getSpaceForRecord(collection: string, recordId: string): Promise<string>;

  // Test-only: evict cached FileStore for a space so next downloadFile
  // goes through getSharedFileStore() which re-checks SyncClient availability
  _evictFileStoreCache(spaceId: string): void;

  // Lifecycle
  ready: boolean;
}

declare global {
  interface Window {
    __test: TestAPI;
  }
}

// ---------------------------------------------------------------------------
// Collection registry
// ---------------------------------------------------------------------------

const collections: Record<string, CollectionDef> = {
  items,
  notes,
};

function resolveCollection(name: string): CollectionDef {
  const def = collections[name];
  if (!def) throw new Error(`Unknown collection: ${name}`);
  return def;
}

// ---------------------------------------------------------------------------
// TestBridge component — renders inside BetterbaseProvider
// ---------------------------------------------------------------------------

interface TestBridgeProps {
  auth: {
    isAuthenticated: boolean;
    personalSpaceId: string | null;
    encryptionKey: Uint8Array | null;
    keypair: { privateKeyJwk: JsonWebKey; publicKeyJwk: JsonWebKey } | null;
  };
}

export function TestBridge({ auth }: TestBridgeProps) {
  const db = useSyncDb();
  const sync = useSync();
  const spaces = useSpaces();
  const invitations = usePendingInvitations();
  const activeSpaces = useActiveSpaces();
  const fileStore = useFileStore();
  const spaceManager = useSpaceManager();
  const presenceManager = usePresenceManager();
  const eventManager = useEventManager();

  // Cache shared-space FileStores to avoid recreating
  const sharedFileStoresRef = useRef(new Map<string, FileStore>());

  // Event subscription accumulator: key → { events, unsubscribe }
  const eventSubsRef = useRef(
    new Map<string, { events: Array<{ data: unknown; peer: string }>; unsubscribe: () => void }>(),
  );

  // Use refs so the API functions always see the latest values
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const invitationsRef = useRef(invitations);
  invitationsRef.current = invitations;
  const activeSpacesRef = useRef(activeSpaces);
  activeSpacesRef.current = activeSpaces;
  const presenceManagerRef = useRef(presenceManager);
  presenceManagerRef.current = presenceManager;
  const eventManagerRef = useRef(eventManager);
  eventManagerRef.current = eventManager;

  // Build a FileStore for a shared space on demand
  async function getSharedFileStore(spaceId: string): Promise<FileStore> {
    const cached = sharedFileStoresRef.current.get(spaceId);
    if (cached) return cached;

    const syncClient = spaceManager.getSyncClient(spaceId);
    if (!syncClient) throw new Error(`No SyncClient for space ${spaceId}`);
    const spaceKey = spaceManager.getSpaceKey(spaceId);
    if (!spaceKey) throw new Error(`No space key for space ${spaceId}`);
    const epoch = spaceManager.getSpaceEpoch(spaceId) ?? 1;

    const filesClient = new FilesClient(syncClient);

    const store = new FileStore({
      dbName: `betterbase-file-cache-${spaceId}`,
    });
    await store.connect({
      filesClient,
      epochKey: spaceKey,
      epoch,
      spaceId,
    });

    sharedFileStoresRef.current.set(spaceId, store);
    return store;
  }

  useEffect(() => {
    const api: TestAPI = {
      ready: true,

      // -- Auth state --
      getAuthState() {
        return {
          isAuthenticated: auth.isAuthenticated,
          personalSpaceId: auth.personalSpaceId,
          hasEncryptionKey: !!auth.encryptionKey,
          hasKeypair: !!auth.keypair,
        };
      },

      async getSelfDID() {
        if (!auth.keypair) return null;
        return encodeDIDKeyFromJwk(auth.keypair.publicKeyJwk);
      },

      // -- DB CRUD --
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async put(
        collection: string,
        data: Record<string, unknown>,
        options?: { space?: string },
      ): Promise<string> {
        const def = resolveCollection(collection);
        const record = await (db as any).put(def, data, options);
        return record.id as string;
      },

      async get(collection: string, id: string): Promise<Record<string, unknown> | null> {
        const def = resolveCollection(collection);
        const record = await (db as any).get(def, id);
        return (record as Record<string, unknown>) ?? null;
      },

      async query(collection: string, query?: object): Promise<Record<string, unknown>[]> {
        const def = resolveCollection(collection);
        const result = await (db as any).query(def, query);
        return [...result.records] as Record<string, unknown>[];
      },

      async patch(collection: string, data: Record<string, unknown>): Promise<void> {
        const def = resolveCollection(collection);
        await (db as any).patch(def, data);
      },

      async del(collection: string, id: string): Promise<void> {
        const def = resolveCollection(collection);
        await (db as any).delete(def, id);
      },

      // -- Sync --
      async sync(): Promise<void> {
        await syncRef.current.sync();
      },

      getSyncStatus() {
        const s = syncRef.current;
        return { phase: s.phase, syncing: s.syncing, error: s.error };
      },

      async waitForSync(timeoutMs = 30_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const s = syncRef.current;
          if (s.phase === "ready" && !s.syncing) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("waitForSync timed out");
      },

      // -- Spaces --
      async createSpace(): Promise<string> {
        return spaces.createSpace();
      },

      async invite(
        spaceId: string,
        handle: string,
        meta?: { role?: string; spaceName?: string },
      ): Promise<void> {
        await spaces.invite(spaceId, handle, meta as Parameters<typeof spaces.invite>[2]);
      },

      async getInvitations() {
        return invitationsRef.current.records.map((r) => {
          const rec = r as SpaceRecord & SpaceFields;
          return {
            id: rec.id,
            spaceId: rec.spaceId,
            _spaceId: rec._spaceId,
            invitedBy: rec.invitedBy,
            name: rec.name,
          };
        });
      },

      async acceptInvitation(recordId: string): Promise<void> {
        const record = invitationsRef.current.records.find((r) => r.id === recordId) as
          | (SpaceRecord & SpaceFields)
          | undefined;
        if (!record) throw new Error(`Invitation ${recordId} not found`);
        await spaces.accept(record);
      },

      async declineInvitation(recordId: string): Promise<void> {
        const record = invitationsRef.current.records.find((r) => r.id === recordId) as
          | (SpaceRecord & SpaceFields)
          | undefined;
        if (!record) throw new Error(`Invitation ${recordId} not found`);
        await spaces.decline(record);
      },

      async getActiveSpaces() {
        return activeSpacesRef.current.records.map((r) => {
          const rec = r as SpaceRecord & SpaceFields & { spaceId: string };
          return {
            id: rec.id,
            _spaceId: rec._spaceId,
            spaceId: rec.spaceId,
            status: rec.status,
          };
        });
      },

      async getMembers(spaceId: string): Promise<Member[]> {
        return spaces.getMembers(spaceId);
      },

      async removeMember(spaceId: string, memberDID: string): Promise<void> {
        await spaces.removeMember(spaceId, memberDID);
      },

      async checkInvitations(): Promise<number> {
        return spaces.checkInvitations();
      },

      // -- Files --
      async uploadFile(
        fileId: string,
        data: number[],
        recordId: string,
        spaceId?: string,
      ): Promise<void> {
        const store = spaceId ? await getSharedFileStore(spaceId) : fileStore;
        if (!store) throw new Error("FileStore not available (no epoch key)");
        await store.put(fileId, new Uint8Array(data), recordId);
        // Wait for the background processQueue (fire-and-forget from put) to finish
        await store.processQueue();
      },

      async downloadFile(fileId: string, spaceId?: string): Promise<number[]> {
        const store = spaceId ? await getSharedFileStore(spaceId) : fileStore;
        if (!store) throw new Error("FileStore not available (no epoch key)");
        const data = await store.get(fileId);
        if (!data) throw new Error(`File ${fileId} not found`);
        return Array.from(data);
      },

      // -- Space operations --
      async userExists(handle: string): Promise<boolean> {
        return spaces.userExists(handle);
      },

      async moveToSpace(
        collection: string,
        recordId: string,
        targetSpaceId: string,
      ): Promise<string> {
        const def = resolveCollection(collection);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newRecord = await (moveToSpaceFn as any)(db, def, recordId, targetSpaceId);
        return newRecord.id as string;
      },

      async bulkMoveToSpace(
        collection: string,
        recordIds: string[],
        targetSpaceId: string,
      ): Promise<string[]> {
        const def = resolveCollection(collection);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newRecords = await (bulkMoveToSpaceFn as any)(db, def, recordIds, targetSpaceId);
        return newRecords.map((r: { id: string }) => r.id);
      },

      // -- Presence --
      setPresence(spaceId: string, data: unknown): void {
        const pm = presenceManagerRef.current;
        if (!pm) throw new Error("PresenceManager not available");
        pm.setPresence(spaceId, data);
      },

      clearPresence(spaceId: string): void {
        const pm = presenceManagerRef.current;
        if (!pm) throw new Error("PresenceManager not available");
        pm.clearPresence(spaceId);
      },

      getPeers(spaceId: string): Array<{ peer: string; data: unknown }> {
        const pm = presenceManagerRef.current;
        if (!pm) throw new Error("PresenceManager not available");
        return pm.getPeers(spaceId);
      },

      getPeerCount(spaceId: string): number {
        const pm = presenceManagerRef.current;
        if (!pm) throw new Error("PresenceManager not available");
        return pm.getPeerCount(spaceId);
      },

      // -- Ephemeral events --
      sendEvent(spaceId: string, name: string, data: unknown): void {
        const em = eventManagerRef.current;
        if (!em) throw new Error("EventManager not available");
        em.sendEvent(spaceId, name, data);
      },

      subscribeToEvent(spaceId: string, name: string): string {
        const em = eventManagerRef.current;
        if (!em) throw new Error("EventManager not available");
        const key = `${spaceId}:${name}`;
        if (eventSubsRef.current.has(key)) return key;
        const events: Array<{ data: unknown; peer: string }> = [];
        const unsubscribe = em.onEvent(spaceId, name, (data, peer) => {
          events.push({ data, peer });
        });
        eventSubsRef.current.set(key, { events, unsubscribe });
        return key;
      },

      getReceivedEvents(key: string): Array<{ data: unknown; peer: string }> {
        const sub = eventSubsRef.current.get(key);
        return sub ? [...sub.events] : [];
      },

      unsubscribeEvent(key: string): void {
        const sub = eventSubsRef.current.get(key);
        if (sub) {
          sub.unsubscribe();
          eventSubsRef.current.delete(key);
        }
      },

      // -- Epoch rotation --
      async rotateSpaceKey(spaceId: string): Promise<void> {
        await spaceManager.rotateSpaceKey(spaceId);
      },

      getSpaceEpoch(spaceId: string): number | null {
        return spaceManager.getSpaceEpoch(spaceId) ?? null;
      },

      // -- Utility --
      async getSpaceForRecord(collection: string, recordId: string): Promise<string> {
        const def = resolveCollection(collection);
        const record = await (db as any).get(def, recordId);
        if (!record) throw new Error(`Record ${recordId} not found`);
        return record._spaceId as string;
      },

      _evictFileStoreCache(spaceId: string): void {
        sharedFileStoresRef.current.delete(spaceId);
      },
    };

    window.__test = api;

    return () => {
      window.__test = undefined as unknown as TestAPI;
      for (const store of sharedFileStoresRef.current.values()) {
        store.dispose();
      }
      sharedFileStoresRef.current.clear();
      for (const sub of eventSubsRef.current.values()) {
        sub.unsubscribe();
      }
      eventSubsRef.current.clear();
    };
    // presenceManager and eventManager are tracked via refs — no need
    // to include them here (avoids teardown/rebuild mid-test on connect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, spaces, fileStore, spaceManager, auth]);

  return <div id="status">ready</div>;
}
