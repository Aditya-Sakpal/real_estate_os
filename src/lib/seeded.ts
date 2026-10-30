/**
 * Deterministic randomness for the sample screens.
 *
 * The same seed always deals the same numbers, so a sample page seeded from
 * the date is stable through a day, the server render and the browser agree,
 * and nothing reshuffles on reload. The call log carries its own copy of this;
 * visits, partners and reports share this one.
 */
export function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const chance = (p: number) => next() < p;
  const weighted = <T,>(xs: readonly (readonly [T, number])[]): T => {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [x, w] of xs) {
      r -= w;
      if (r <= 0) return x;
    }
    return xs[xs.length - 1][0];
  };
  return { next, int, pick, chance, weighted };
}

export type Rng = ReturnType<typeof seeded>;

/** An invented Indian mobile number, `+91` and ten digits starting 7 to 9. */
export function samplePhone(r: Rng): string {
  return `+91${r.int(7, 9)}${String(r.int(0, 999_999_999)).padStart(9, "0")}`;
}

/**
 * Invented buyers. First and last names drawn apart so the pool is large, and
 * the language follows the surname the way it roughly does in Pune.
 */
export const FIRST_NAMES = [
  "Aarav", "Ishaan", "Rohit", "Sneha", "Kavita", "Anil", "Sunita", "Vivek", "Pradeep", "Manasi",
  "Tejas", "Shruti", "Omkar", "Sayali", "Ajay", "Pallavi", "Nilesh", "Swati", "Harish", "Deepak",
  "Gauri", "Mahesh", "Rashmi", "Sachin", "Ketaki", "Yogesh", "Aparna", "Varun", "Nandini", "Arjun",
  "Farah", "Zoya", "Salim", "Joseph", "Anita", "Ravi", "Venkat", "Meenakshi", "Prachi", "Kunal",
] as const;

export const LAST_NAMES: readonly (readonly [string, "Marathi" | "Hindi" | "English"])[] = [
  ["Kulkarni", "Marathi"], ["Deshpande", "Marathi"], ["Joshi", "Marathi"], ["Patil", "Marathi"],
  ["Pawar", "Marathi"], ["Shinde", "Marathi"], ["Jadhav", "Marathi"], ["Gaikwad", "Marathi"],
  ["Chavan", "Marathi"], ["More", "Marathi"], ["Sawant", "Marathi"], ["Bhosale", "Marathi"],
  ["Sharma", "Hindi"], ["Verma", "Hindi"], ["Gupta", "Hindi"], ["Agarwal", "Hindi"],
  ["Mishra", "Hindi"], ["Thakur", "Hindi"], ["Singh", "Hindi"], ["Khan", "Hindi"], ["Shaikh", "Hindi"],
  ["Iyer", "English"], ["Nair", "English"], ["Menon", "English"], ["Reddy", "English"],
  ["Rao", "English"], ["D'Souza", "English"], ["Fernandes", "English"], ["Mehta", "English"], ["Shah", "English"],
];

export function sampleName(r: Rng): { name: string; lang: "Marathi" | "Hindi" | "English" } {
  const [last, lang] = r.pick(LAST_NAMES);
  return { name: `${r.pick(FIRST_NAMES)} ${last}`, lang };
}

/**
 * Invented channel-partner firms. None of them is a real firm; two of them
 * already appear on the lead board, which is why they lead the list.
 */
export const SAMPLE_FIRMS = [
  "Keystone Realty",
  "Pune Homes Advisory",
  "Urban Nest Realtors",
  "Deccan Estates",
  "Shree Ganesh Realty",
  "Sai Krupa Properties",
  "Baner Homes Consultants",
  "Wakad Property Point",
  "Sahyadri Realty Partners",
  "Kothrud Home Finders",
  "Blue Door Realtors",
  "Hinjewadi Nest Advisors",
] as const;
