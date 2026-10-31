"""Unit tests for series.moving_average."""
import unittest

from src.series import moving_average


class TestMovingAverage(unittest.TestCase):
    def test_window_equals_length(self):
        self.assertEqual(moving_average([2.0, 4.0, 6.0], 3), [4.0])

    def test_basic_window(self):
        self.assertEqual(moving_average([1.0, 2.0, 3.0, 4.0], 2), [1.5, 2.5, 3.5])

    def test_window_one_is_identity(self):
        data = [5.0, -1.0, 0.5]
        self.assertEqual(moving_average(data, 1), data)

    def test_invalid_window_raises(self):
        with self.assertRaises(ValueError):
            moving_average([1.0, 2.0], 0)
        with self.assertRaises(ValueError):
            moving_average([1.0, 2.0], 3)

    def test_empty_series(self):
        self.assertEqual(moving_average([], 1), [])


if __name__ == "__main__":
    unittest.main()
