"""One test means one order: asking again while the first is open must not create a second."""
import main


def _setup(monkeypatch):
    monkeypatch.setattr(main, "get_valid_hospital_id", lambda h: h or "h1")
    monkeypatch.setattr(main, "get_active_admission", lambda pid: None)
    monkeypatch.setattr(main, "hospital_catalog_overrides", lambda h: {})


def _order(pid, names):
    return main.create_test_orders(patient_id=pid, test_names=names, doctor_name="Dr Test", hospital_id="h1")


def _count(pid, test_type):
    return len(main.local_query("SELECT id FROM test_orders WHERE patient_id = ? AND test_type = ?", (pid, test_type)))


def test_asking_twice_makes_one_order(monkeypatch):
    _setup(monkeypatch)
    first = _order("p-dup", ["CBC"])
    second = _order("p-dup", ["Complete Blood Count"])
    assert len(first) == 1 and not first[0].get("already_ordered")
    assert len(second) == 1 and second[0]["already_ordered"] and second[0]["id"] == first[0]["id"]
    assert _count("p-dup", first[0]["test_type"]) == 1


def test_same_test_twice_in_one_sentence_is_one_order(monkeypatch):
    _setup(monkeypatch)
    out = _order("p-one", ["CBC", "complete blood count", "CBC"])
    assert len(out) == 1


def test_a_cancelled_test_can_be_ordered_again(monkeypatch):
    _setup(monkeypatch)
    first = _order("p-redo", ["CBC"])
    main.local_execute("UPDATE test_orders SET status = 'cancelled' WHERE id = ?", (first[0]["id"],))
    again = _order("p-redo", ["CBC"])
    assert not again[0].get("already_ordered") and again[0]["id"] != first[0]["id"]


def test_the_reply_says_it_was_already_ordered(monkeypatch):
    _setup(monkeypatch)
    _order("p-say", ["CBC"])
    reply = main._describe_created_orders(_order("p-say", ["CBC"]), "Rajesh")
    assert "already ordered" in reply


def test_confirming_an_admission_twice_is_refused(monkeypatch):
    import asyncio
    monkeypatch.setattr(main, "get_active_admission", lambda pid: {"id": "a1", "bed_id": "b1"})
    out = asyncio.run(main.confirm_admission({"patient_id": "p-adm", "bed_id": "b2", "ward_id": "w1"}))
    assert out["status"] == "error" and "already admitted" in out["message"]
