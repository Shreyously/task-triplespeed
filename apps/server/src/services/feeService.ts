import Decimal from "decimal.js";
import { FEES } from "@pullvault/common";

export function tradeFee(amount: Decimal): Decimal {
  return amount.times(FEES.TRADE_FEE_RATE).toDecimalPlaces(2);
}

export function auctionFee(amount: Decimal): Decimal {
  return amount.times(FEES.AUCTION_FEE_RATE).toDecimalPlaces(2);
}
