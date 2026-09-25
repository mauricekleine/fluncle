import { restoreDevVars } from "./stack";

export default function globalTeardown(): void {
  restoreDevVars();
}
