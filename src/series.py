"""Minimal example module: simple moving average over a numeric series."""
from __future__ import annotations

from typing import Sequence


def moving_average(data: Sequence[float], window: int) -> list[float]:
    """Return the simple moving average of *data* with the given *window* size.

    Raises ValueError if window < 1 or window > len(data) (unless data is empty).
    """
    if window < 1:
        raise ValueError("window must be >= 1")
    if not data:
        return []
    if window > len(data):
        raise ValueError("window must not exceed series length")
    result: list[float] = []
    acc = sum(data[:window])
    result.append(acc / window)
    for i in range(window, len(data)):
        acc += data[i] - data[i - window]
        result.append(acc / window)
    return result
