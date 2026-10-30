/**
 * Which language to open a call in, guessed from the buyer's name when the
 * enquiry did not say. A Marathi surname in Pune is a buyer who usually
 * answers in Marathi; a Hindi-belt or Gujarati surname one who answers in
 * Hindi. The call already starts in the lead's language and Sarvam switches
 * the moment the buyer answers in another, so a wrong guess costs a line.
 *
 * Only the language is ever kept. A surname also says community and caste,
 * and nothing here stores, shows or reasons about either: the lists exist to
 * pick between Hindi and Marathi and nothing else.
 *
 * Pure and client-safe.
 */

export type GuessedLanguage = "mr" | "hi";

/** Surnames that are Marathi far more often than not. */
const MARATHI = new Set(
  (
    "patil pawar shinde jadhav more kale gaikwad bhosale bhonsle chavan deshmukh deshpande kulkarni joshi apte gokhale phadke karve " +
    "bapat sathe ranade bhide damle paranjpe paranjape kelkar gadgil limaye natu khare abhyankar agashe athavale bhagwat bhave chitale " +
    "datar godbole gupte joglekar kanetkar karandikar ketkar lele marathe modak mone nadkarni oak padhye pendse phatak sahasrabuddhe " +
    "sane sapre tilak vaidya velankar wagh mane salunkhe salunke shirke sawant kadam kamble thorat nikam mohite ghorpade jagtap kokate " +
    "sonawane dhole lokhande mhatre patole shelar shewale surve tambe thackeray thakre waghmare zende dhumal gawade ghadge ghule gore " +
    "ingle jagdale jawale kasar khandagale khot kharat lande londhe mule nalawade patange pingale raut sakpal satpute shete shirsat " +
    "shitole sutar tawde udmale wable deshmane bhagat chaudhari choudhari dange darekar dhamale dhawale dighe gaware gawde ghodke " +
    "gunjal hande hinge jadhao jagadale kakade kapse karale katkar khedkar kolhe kshirsagar landge lonkar magar mahadik mandlik " +
    "mhaske mohol nagare naik nimbalkar pachpute pansare pathare phule pote rane rokade sabale sathe shejwal shewalkar shingade " +
    "shinkar sonavane surywanshi suryavanshi tapkir thombare tupe varpe wadkar waghere walke zagade bobade borate " +
    "chandane dalvi desai gavade jagtap kamath kanade kharade kirdat lohar mahajan misal palande parab prabhu rasal " +
    "shedge sule tare thakare vichare wakchaure"
  ).split(/\s+/),
);

/** Surnames that are Hindi-speaking (or Gujarati, Marwari and Punjabi, who take a Hindi call) far more often than not. */
const HINDI = new Set(
  (
    "singh sharma verma varma gupta agarwal agrawal aggarwal mishra pandey tiwari tiwary tripathi dubey dwivedi chaturvedi " +
    "srivastava shrivastava saxena kumar jha sinha rai shukla bajpai vajpayee awasthi upadhyay rathore rathod chauhan " +
    "rajput bhatia malhotra kapoor khanna mehra arora jain maheshwari bansal goyal goel mittal singhal khandelwal shah patel " +
    "mehta modi parikh trivedi thakkar soni yadav kushwaha maurya pathak ojha bhardwaj sethi chopra tandon kohli ahuja " +
    "chaddha chadha bhalla grover luthra sodhi gill sandhu dhillon sidhu bedi oberoi khurana nagpal goenka bajaj poddar " +
    "jhunjhunwala birla rastogi tyagi chaudhary choudhary sengar bisht negi rawat"
  ).split(/\s+/),
);

/** First names that are Marathi far more often than not, for a name with no surname we know. */
const MARATHI_FIRST = new Set(
  (
    "prathamesh omkar swapnil sayali rutuja mrunal snehal pranali ketaki sanket shrikant dnyaneshwar dnyanesh vithal pandurang " +
    "tukaram shivaji sambhaji mangesh sopan dattatray dattatraya shubhangi madhura ninad chinmay " +
    "sharvari sanika rasika shardul shantanu vrushali vaishnavi pratiksha mayuresh siddhesh kaustubh"
  ).split(/\s+/),
);

/**
 * The language a name suggests, or null when it says nothing reliable. The
 * surname decides; a first name decides only when there is no surname we
 * know. A Marathi "-kar" surname (Tendulkar, Wadekar) counts as Marathi.
 */
export function guessLanguage(name: string | null | undefined): GuessedLanguage | null {
  const parts = (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((p) => p.length >= 2);
  if (!parts.length) return null;
  const surnames = parts.length > 1 ? parts.slice(1) : [];
  for (const s of [...surnames].reverse()) {
    if (MARATHI.has(s)) return "mr";
    if (HINDI.has(s)) return "hi";
    if (s.length >= 5 && /kar$/.test(s)) return "mr";
  }
  if (MARATHI_FIRST.has(parts[0])) return "mr";
  return null;
}
