import { collection, t, type CollectionRead } from "betterbase/db";

export const items = collection("items")
  .v(1, {
    title: t.string(),
    value: t.number(),
    tags: t.array(t.string()),
  })
  .build();

export type Item = CollectionRead<typeof items>;

export const notes = collection("notes")
  .v(1, {
    body: t.text(),
    pinned: t.boolean(),
  })
  .build();

export type Note = CollectionRead<typeof notes>;
