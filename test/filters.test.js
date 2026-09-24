const test = require('node:test');
const assert = require('node:assert');
const { makeTitleFilter } = require('../src/filters');

// Fixed fixture, not the live config — keeps these tests stable and shared across contributors,
// independent of whatever filterTitle list either person is running locally.
const FIXTURE_FILTER_TITLE = [
  'forward deploy',
  '=frontend',
  '=front-end',
  '=front end',
  '=full stack',
  '=full-stack',
  '=fullstack',
  '=engineer',
  '=developer',
  '-staff',
  '=technical staff',
  '-intern',
  '-=manager',
  '-=director',
  '-=developer relations',
];

const allowed = makeTitleFilter(FIXTURE_FILTER_TITLE);

// [title, should be kept]
const cases = {
  'includes: engineer / developer': [
    ['Software Engineer', true],
    ['Senior Software Developer', true],
    ['Software Engineer II', true],
    ['Backend Engineer', true],
    ['React Developer', true],
  ],
  'includes: frontend / full stack variants': [
    ['Frontend Lead', true],
    ['Front-end Architect', true],
    ['Front End Specialist', true],
    ['Full Stack Consultant', true],
    ['Full-Stack Wizard', true],
    ['Fullstack Ninja', true],
  ],
  'includes: forward deploy (contains)': [
    ['Forward Deployed Engineer', true],
    ['Forward Deploy Lead', true],
  ],
  'whole word: engineer / developer do not match longer words': [
    ['Engineering Consultant', false],
    ['Business Development Associate', false],
  ],
  'excludes: developer relations': [
    ['Developer Relations Lead', false],
    ['Senior Developer Relations Engineer', false],
    ['Software Developer', true],
  ],
  'excludes: staff (contains, so staffing too)': [
    ['Staff Software Engineer', false],
    ['Staff Engineer', false],
    ['Staffing Engineer', false],
    ['Senior Staffing Developer', false],
  ],
  'exception: technical staff overrides staff': [
    ['Member of Technical Staff', true],
    ['Senior Member of Technical Staff', true],
  ],
  'excludes: manager / director beat everything before them': [
    ['Engineering Manager', false],
    ['Software Engineer, Manager', false],
    ['Director of Engineering', false],
    ['Technical Staff Manager', false],
  ],
  'excludes: intern': [
    ['Software Engineering Intern', false],
    ['Summer Intern, Engineering', false],
    ['Software Engineer', true],
  ],
  'no include matches: dropped': [
    ['Product Designer', false],
    ['Sales Executive', false],
    ['Recruiter', false],
  ],
  'case-insensitive': [
    ['SOFTWARE ENGINEER', true],
    ['staff software engineer', false],
    ['MEMBER OF TECHNICAL STAFF', true],
  ],
};

for (const [group, items] of Object.entries(cases)) {
  test(group, () => {
    for (const [title, expected] of items) {
      assert.strictEqual(allowed(title), expected, `"${title}" should be ${expected ? 'kept' : 'dropped'}`);
    }
  });
}
