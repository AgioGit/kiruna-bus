export const TRAIN_SHUTTLE_LINE_ID = 110000001;
export const AIRPORT_SHUTTLE_LINE_ID = 110000552;
const EMPTY_RUN_LINE_ID = 110000900;

export function isApproximateLine(lineId) {
  return lineId === TRAIN_SHUTTLE_LINE_ID || lineId === AIRPORT_SHUTTLE_LINE_ID;
}

export function isLineEnabledByDefault(lineId) {
  return lineId !== EMPTY_RUN_LINE_ID && !isApproximateLine(lineId);
}
