"""Ward board helpers: room pricing and bed ordering."""
import main


def test_room_cost_follows_the_room_type_not_a_flat_500():
    assert main.room_cost_per_day("ICU Room") == 10000
    assert main.room_cost_per_day("General Ward") == 1200
    assert main.room_cost_per_day("Private Room") == 5000
    assert main.room_cost_per_day("something unknown") == 500      # a safe default, never a crash
    assert main.room_cost_per_day(None) == 500


def test_beds_sort_naturally():
    beds = ["ICU-10", "ICU-02", "ICU-01", "ICU-11", "ICU-03"]
    assert sorted(beds, key=main._natural_key) == ["ICU-01", "ICU-02", "ICU-03", "ICU-10", "ICU-11"]
    assert sorted(["B10", "B9", "B1"], key=main._natural_key) == ["B1", "B9", "B10"]
