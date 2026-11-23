"""Protect recognized numbers during translation and script conversion."""
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from unicodedata import decimal, normalize


def numbered(words: str, start: int = 0) -> dict[str, int]:
    return {alias: value for value, group in enumerate(words.split(), start) for alias in group.split("|")}


def tens(words: str) -> dict[str, int]:
    return {alias: 10 * value for alias, value in numbered(words, 2).items()}


ENGLISH = {
    **numbered("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"),
    **tens("twenty thirty forty fifty sixty seventy eighty ninety"),
    "hundred": 100, "thousand": 1_000, "lakh": 100_000, "million": 1_000_000, "crore": 10_000_000, "billion": 1_000_000_000,
}
TELUGU = {
    **numbered("సున్నా ఒకటి రెండు మూడు నాలుగు ఐదు|అయిదు ఆరు ఏడు ఎనిమిది తొమ్మిది పది పదకొండు పన్నెండు పదమూడు పద్నాలుగు|పదనాలుగు పదిహేను పదహారు పదిహేడు పద్దెనిమిది పంతొమ్మిది"),
    **tens("ఇరవై|ఇరువై ముప్పై|ముప్పయి|ముప్పయ్ నలభై యాభై అరవై డెబ్బై ఎనభై తొంభై"),
    "వంద": 100, "వెయ్యి": 1_000, "వేలు": 1_000, "లక్ష": 100_000, "కోటి": 10_000_000,
    **numbered("sunna okati rendu moodu naalugu|nalugu aidu|ayidu aaru edu|yedu enimidi tommidi padi"),
    **tens("iravai|iravayi muppai|muppayi nalabhai yaabhai|yabhai aravai debbai enabhai tombhai"),
}
KANNADA = {
    **numbered("ಸೊನ್ನೆ ಒಂದು ಎರಡು ಮೂರು ನಾಲ್ಕು ಐದು ಆರು ಏಳು ಎಂಟು ಒಂಬತ್ತು ಹತ್ತು ಹನ್ನೊಂದು ಹನ್ನೆರಡು ಹದಿಮೂರು ಹದಿನಾಲ್ಕು ಹದಿನೈದು ಹದಿನಾರು ಹದಿನೇಳು ಹದಿನೆಂಟು ಹತ್ತೊಂಬತ್ತು"),
    **tens("ಇಪ್ಪತ್ತು ಮೂವತ್ತು ನಲವತ್ತು ಐವತ್ತು ಅರವತ್ತು ಎಪ್ಪತ್ತು ಎಂಬತ್ತು ತೊಂಬತ್ತು"),
    "ನೂರು": 100, "ಸಾವಿರ": 1_000, "ಲಕ್ಷ": 100_000, "ಕೋಟಿ": 10_000_000,
    **numbered("sonne ondu eradu mooru naalku aidu aaru elu entu ombattu hattu"),
    **tens("ippattu moovattu nalavattu aivattu aravattu eppattu embattu tombattu"),
}
TAMIL = {
    **numbered("பூஜ்யம் ஒன்று இரண்டு|இரு மூன்று நான்கு ஐந்து ஆறு ஏழு எட்டு ஒன்பது பத்து பதினொன்று பன்னிரண்டு பதின்மூன்று பதினான்கு பதினைந்து பதினாறு பதினேழு பதினெட்டு பத்தொன்பது|பதினொன்பது"),
    **tens("இருபது முப்பது நாற்பது ஐம்பது அறுபது எழுபது எண்பது தொண்ணூறு"),
    "நூறு": 100, "ஆயிரம்": 1_000, "லட்சம்": 100_000, "கோடி": 10_000_000,
    **numbered("poojyam ondru irandu|rendu moondru|moonu naangu|naalu aindhu|anju aaru ezhu ettu onbadhu paththu|pathu"),
    **tens("irubadhu muppadhu naarpadhu aimbadhu arubadhu ezhubadhu enbadhu thonnooru"),
}
HINDI = {
    **numbered(
        "शून्य|ज़ीरो एक दो तीन चार पाँच|पांच छह|छः सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह|पन्द्रह सोलह सत्रह अठारह उन्नीस "
        "बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस "
        "तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस "
        "चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास "
        "पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ "
        "साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर "
        "सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी "
        "अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी "
        "नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे"
    ),
    "सौ": 100, "हज़ार": 1_000, "हजार": 1_000, "लाख": 100_000, "करोड़": 10_000_000,
    # “do” and “teen” are also common unrelated English tokens. In Roman
    # input they are too ambiguous to replace without context.
    "ek": 1, "chaar": 4, "paanch": 5, "chhah": 6, "saat": 7, "aath": 8, "nau": 9,
    "bees": 20, "tees": 30, "paintees": 35, "paintis": 35, "chaalis": 40, "pachaas": 50,
}

for decade, multiple in tuple(TELUGU.items()):
    if multiple in range(20, 100, 10) and not decade.isascii():
        for unit, value in tuple(TELUGU.items()):
            if 1 <= value <= 9 and not unit.isascii():
                TELUGU[decade + unit] = multiple + value

for index, stem in enumerate("ಇಪ್ಪತ್ತ ಮೂವತ್ತ ನಲವತ್ತ ಐವತ್ತ ಅರವತ್ತ ಎಪ್ಪತ್ತ ಎಂಬತ್ತ ತೊಂಬತ್ತ".split(), 2):
    for unit, suffix in enumerate("ೊಂದು ೆರಡು ೂರು ್ನಾಲ್ಕು ೈದು ಾರು ೇಳು ೆಂಟು ೊಂಬತ್ತು".split(), 1):
        KANNADA[stem + suffix] = index * 10 + unit

for index, stem in enumerate("இருபத்து முப்பத்து நாற்பத்து ஐம்பத்து அறுபத்து எழுபத்து எண்பத்து தொண்ணூற்று".split(), 2):
    for unit, suffix in enumerate("ஒன்று இரண்டு மூன்று நான்கு ஐந்து ஆறு ஏழு எட்டு ஒன்பது".split(), 1):
        TAMIL[stem + " " + suffix] = index * 10 + unit
    for unit, suffix in enumerate("ொன்று ிரண்டு ுமூன்று ுநான்கு ைந்து ாறு ேழு ெட்டு ொன்பது".split(), 1):
        TAMIL[stem[:-1] + suffix] = index * 10 + unit

WORDS = {"te-IN": TELUGU, "kn-IN": KANNADA, "ta-IN": TAMIL, "hi-IN": HINDI}
DIGITS = r"(?:(?<!\d)[+-])?(?:\d{1,3},(?:\d{2,3},)*\d{3}|\d+)(?:\.\d+)?(?:/\d+)?"
WORD_BOUNDARY = r"\w\u0900-\u0DFF"


@lru_cache(maxsize=5)
def number_pattern(language: str):
    words = {**ENGLISH, **WORDS.get(language, {})}
    alternatives = "|".join(re.escape(word).replace(r"\ ", r"\s+") for word in sorted(words, key=len, reverse=True))
    return re.compile(rf"{DIGITS}|(?<![{WORD_BOUNDARY}])(?:{alternatives})(?![{WORD_BOUNDARY}])", re.IGNORECASE), words


def word_amounts(text: str, language: str):
    pattern, words = number_pattern(language)
    matches = list(pattern.finditer(text))
    index = 0
    while index < len(matches):
        match = matches[index]
        index += 1
        token = " ".join(match[0].lower().split())
        value = words.get(token)
        if value is None:
            numeric = "".join(str(decimal(char)) if char.isdecimal() else char for char in token)
            yield match.start(), match.end(), numeric
            continue
        start, end = match.span()
        # Hindi दो also means “give” as a sentence-ending imperative.
        # A leading or compound दो still works (e.g. “दो किलो”, “दो सौ”).
        if language == "hi-IN" and token == "दो" and text[:start].strip() and not re.match(r"\s+[^\W\d_]", text[end:]):
            continue
        total, segment, scale = 0, value, float("inf")
        # A bare scale (e.g. “lakh” in “2 lakh”) is a unit, not another amount.
        if value >= 100 and text[:start].rstrip()[-1:].isdigit():
            continue
        if value >= 1_000:
            total, segment, scale = value, 0, value
        while index < len(matches):
            following = matches[index]
            gap = text[end:following.start()]
            subsequent = words.get(" ".join(following[0].lower().split()))
            if subsequent is None or not re.fullmatch(r"\s+|-|\s+and\s+", gap, re.IGNORECASE):
                break
            if subsequent >= 1_000 and subsequent < scale and segment:
                total, segment, scale = total + segment * subsequent, 0, subsequent
            elif subsequent == 100 and 0 < segment < 10:
                segment *= subsequent
            elif segment % 100 == 0 and subsequent < 100 and (segment or total):
                segment += subsequent
            elif segment % 100 in range(20, 100, 10) and subsequent < 10 and gap.strip().lower() != "and":
                segment += subsequent
            else:
                break
            end = following.end()
            index += 1
        yield start, end, str(total + segment)


@dataclass(frozen=True)
class ProtectedAmounts:
    text: str
    replacements: dict[str, str]
    prefix: str

    @property
    def slot(self) -> re.Pattern[str]:
        return re.compile(r"\[LFQ(" + self.prefix + r"[A-Z]+)\]")

    @property
    def contains_words(self) -> bool:
        return any(char.isalpha() for char in self.slot.sub("", self.text))

    def restore(self, output: str) -> str | None:
        if not self.replacements:
            return output
        slot = self.slot
        if Counter(slot.findall(output)) != Counter(self.replacements.keys()):
            return None
        # Reject any extra digit runs introduced outside the original slots.
        if re.search(r"\d", slot.sub("", output)):
            return None
        return slot.sub(lambda match: self.replacements[match[1]], output)


def protect_amounts(text: str, language: str) -> ProtectedAmounts:
    text = normalize("NFC", text)
    parts, replacements, cursor = [], {}, 0
    # Pick an unused prefix so even literal marker-like user text remains data.
    prefix = "A"
    while "[LFQ" + prefix in text:
        prefix += "A"
    for start, end, value in word_amounts(text, language):
        index, key = len(replacements), ""
        while True:
            index, letter = divmod(index, 26)
            key = chr(65 + letter) + key
            if index == 0:
                break
        marker = prefix + key
        replacements[marker] = value
        parts.extend((text[cursor:start], f"[LFQ{marker}]"))
        cursor = end
    return ProtectedAmounts("".join(parts) + text[cursor:], replacements, prefix)


AMOUNT_INSTRUCTION = (
    " Tokens of the form [LFQAA] already stand for an exact number. "
    "Copy each such token verbatim, exactly once, into each text field; do not spell it out, omit it, or add new numbers. "
    "Translate or transliterate its unit and currency as usual and keep it attached to the same item."
)
