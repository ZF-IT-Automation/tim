# TIM sync secret-node contract (T04)

This document defines the secret payload boundary used by the sync client. It
extends `protocol.md` and `client.md`; it does not enable sync, staging, or a
deployment.

## Threat boundary

The server only receives outer-sync ciphertext. A client with that outer key
but without the secret key can decrypt an envelope, so it is a separate threat
boundary. Such a client must see no secret title, content, tags, or private
metadata. It may see entry ID, parent ID, timestamps, content type, depth,
visibility, tombstone state, LWW metadata, and fact entry is secret. Those
structural fields are necessary for identity, convergence, and tree construction.

Persisted locked state is authoritative. UI placeholder title is display data
only and never security decision. A row is locked when metadata contains
`secret: true` and non-empty `_enc` string. Locked rows retain ciphertext needed
to unlock later.

## Inner payload format

`TimEnvelope.v` remains outer protocol version. For encrypted entry envelopes,
`is_encrypted` is true. Entry payload has public structural shell and locked
metadata:

```json
{
  "id": "entry-id",
  "parent_id": "parent-id-or-null",
  "created_at": "...",
  "accessed_at": "...",
  "content_type": "text",
  "depth": 2,
  "confidence": 1,
  "decay_rate": 0,
  "visibility": 1,
  "irrelevant": 0,
  "favorite": 0,
  "tombstoned_at": null,
  "title": "🔒 [secret]",
  "content": "",
  "tags": "[]",
  "metadata": "{\"secret\":true,\"_enc_v\":2,\"_enc\":\"...\"}",
  "metadata_raw": "{\"secret\":true,\"_enc_v\":2,\"_enc\":\"...\"}"
}
```

`_enc` decrypts to UTF-8 JSON:

```json
{
  "v": 2,
  "id": "entry-id",
  "title": "private title",
  "content": "private content",
  "tags": "[\"#private\"]",
  "metadata": "{\"secret\":true,\"kind\":\"note\"}",
  "metadata_raw": "{\"secret\":true,\"kind\":\"note\"}"
}
```

Complete JSON is authenticated by inner cipher. A v2 decrypt rejects malformed
inner object or an `id` different from shell entry ID; it never reinterprets it
as plaintext or falls back to v1 fields.
Lock shell, including `_enc`, persists on keyless client. On later pull with
secret key, client unlocks every persisted locked row before new cursor pages.
Thus cursor already past envelope cannot prevent recovery. Wrong key fails before
state or cursor changes.

### v1 compatibility

Old encrypted entries have no `_enc_v` (or `_enc_v: 1`). Their `title` and
`content` are individually encrypted, `_enc` encrypts only metadata, and tags
remain in old outer payload. Keyless shells retain those two ciphertexts as
lock-internal `_enc_title` and `_enc_content`, so adding key later can unlock a
cursor-past v1 row. They are migration input, not plaintext. Readers accept and
decrypt v1 exactly as stored. Writers never emit v1: next permitted secret
write emits v2 envelope, encrypting tags and private metadata together.

## Mutation and delivery rules

Store mutation APIs reject changes to persisted locked row. This covers
title/content changes, metadata and tag patches, soft deletes, and curation edits.
Caller must unlock with secret key first. Secret marking is one-directional at
store boundary: attempting to clear `secret: true` errors. `tim secret unlock`
is offline and key-gated; it takes secret passphrase plus sync salt and needs no
server connection. Moving or renaming a locked root is rejected until unlock.
Moving an unlocked ancestor may structurally re-parent locked descendants; that
is permitted because no descendant payload is changed.

Push, mirror, and legacy-queue replay independently apply same rule. Locked or
ciphertext payload is never acknowledged, transformed into plaintext, or sent as
replacement by keyless client. It remains queued and reports missing-secret-key.
Encrypted source payload sends only when it already has v2 ciphertext form, or
key is available to produce it.

Hard entry deletes are ID-only tombstones and may send without secret key: they
contain no private payload and do not replace ciphertext. Soft deletes and all
entry upserts require key when entry is secret or inherited-secret.

Edges are public topology metadata. They may replicate without secret key and
contain only endpoint IDs, type, weight, and edge metadata; never entry values.
Deleting edge follows same policy. Operators needing topology privacy must not
create cross-boundary edges or use distinct future edge-encryption format.

Logs, audits, errors, backups, and queues must never print decrypted inner
payloads. Queue/config/state directories and files retain `0700`/`0600`
contract in `client.md`. Owner scope is limitation: key holder's local TIM DB
and snapshots contain plaintext secrets. Protect that device and every snapshot
destination as secret-bearing storage; snapshots are not encrypted by TIM.
