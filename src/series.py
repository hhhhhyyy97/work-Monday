"""Minimal example module: simple moving average over a numeric series."""
from __future__ import annotations

import math
from typing import Sequence


def moving_average(data: Sequence[float], window: int) -> list[float]:
    """Return the simple moving average of *data* with the given *window* size.

    Uses math.fsum per window for numerical stability. Returns len(data) - window + 1
    full-window averages. Raises ValueError if window < 1 or (data is non-empty and
    window > len(data)).
    """
    if window < 1:
        raise ValueError("window must be >= 1")
    if not data:
        return []
    if window > len(data):
        raise ValueError("window must not exceed series length")

    return [
        math.fsum(data[i : i + window]) / window
        for i in range(len(data) - window + 1)
    ]
