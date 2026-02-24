import { initWorker } from "betterbase/db/worker";
import { items, notes } from "./collections.js";
import { spaces } from "betterbase/sync";

initWorker([items, notes, spaces]);
