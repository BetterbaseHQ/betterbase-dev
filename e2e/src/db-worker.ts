import { initOpfsWorker } from "@betterbase/sdk/db/worker";
import { items, notes } from "./collections.js";
import { spaces } from "@betterbase/sdk/sync";

initOpfsWorker([items, notes, spaces]);
