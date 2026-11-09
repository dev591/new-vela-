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


def test_bed_questions_are_recognised_but_clinical_ones_are_not():
    yes = ["how many beds are free", "any empty beds in ICU", "are there available beds", "bed availability please",
           "how many ICU beds are left", "what is the bed occupancy", "show me vacant beds"]
    no = ["what is his hemoglobin", "show me the latest report", "what's the creatinine trend", "who is next in the queue"]
    assert all(main._BED_QUERY.search(q) for q in yes)
    assert not any(main._BED_QUERY.search(q) for q in no)
