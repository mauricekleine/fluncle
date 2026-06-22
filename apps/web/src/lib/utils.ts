import { clsx, type ClassValue } from "cnfast";
import { twMerge } from "cnfast";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
