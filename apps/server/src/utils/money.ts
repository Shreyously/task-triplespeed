import Decimal from "decimal.js";

export function money(v: string | number | Decimal): Decimal {
  return new Decimal(v).toDecimalPlaces(2);
}
