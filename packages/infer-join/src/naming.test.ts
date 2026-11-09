import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalKey, containerCore, containerCoreKey, editSimilarity, expandAbbrev, jaccard,
  levenshtein, literalKey, matchContainer, matchName, matchNameInContainer, singularize,
  splitTokens, stripContainerPrefix,
} from './naming.ts';

describe('splitTokens', () => {
  it('splits every naming convention onto the same token sequence', () => {
    const expected = ['scheduled', 'at'];
    for (const spelling of ['scheduled_at', 'scheduledAt', 'ScheduledAt', 'scheduled-at', 'SCHEDULED_AT', 'scheduled.at']) {
      assert.deepEqual(splitTokens(spelling), expected, spelling);
    }
  });

  it('breaks acronym runs at the last capital', () => {
    assert.deepEqual(splitTokens('HTTPServerURL'), ['http', 'server', 'url']);
    assert.deepEqual(splitTokens('userID'), ['user', 'id']);
  });

  it('splits digit runs so snake and camel spellings agree', () => {
    assert.deepEqual(splitTokens('sha256Hash'), splitTokens('sha256_hash'));
    assert.deepEqual(splitTokens('sha256Hash'), ['sha', '256', 'hash']);
  });
});

describe('singularize', () => {
  it('handles regular, -ies, -es and irregular plurals', () => {
    assert.equal(singularize('posts'), 'post');
    assert.equal(singularize('categories'), 'category');
    assert.equal(singularize('boxes'), 'box');
    assert.equal(singularize('people'), 'person');
    assert.equal(singularize('indices'), 'index');
  });

  it('does not strip a trailing s that is not a plural', () => {
    for (const word of ['status', 'address', 'analysis', 'process', 'bus', 'metadata', 'pos']) {
      assert.equal(singularize(word), word, word);
    }
  });
});

describe('expandAbbrev', () => {
  it('expands curated abbreviations only', () => {
    assert.equal(expandAbbrev('desc'), 'description');
    assert.equal(expandAbbrev('msg'), 'message');
    assert.equal(expandAbbrev('title'), 'title');
  });

  it('leaves auth alone, because authn and authz are different things', () => {
    assert.equal(expandAbbrev('auth'), 'auth');
  });
});

describe('canonicalKey', () => {
  it('collapses abbreviation and plural spellings', () => {
    assert.equal(canonicalKey('msgs'), 'message');
    assert.equal(canonicalKey('userIds'), canonicalKey('user_ids'));
    assert.equal(canonicalKey('posts'), 'post');
    assert.equal(canonicalKey('Post'), 'post');
  });
});

describe('matchName', () => {
  it('scores every convention pair at 1.0', () => {
    const spellings = ['scheduled_at', 'scheduledAt', 'ScheduledAt', 'scheduled-at'];
    for (const a of spellings) {
      for (const b of spellings) {
        const match = matchName(a, b);
        assert.equal(match.score, 1, `${a} vs ${b}`);
        assert.ok(match.variant === 'identical' || match.variant === 'convention');
      }
    }
  });

  it('scores an abbreviation match below an exact convention match', () => {
    const abbreviated = matchName('msg_body', 'messageBody');
    assert.equal(abbreviated.variant, 'canonical');
    assert.ok(abbreviated.score < 1 && abbreviated.score > 0.9);
  });

  it('rejects unrelated names outright', () => {
    assert.equal(matchName('title', 'body').score, 0);
    assert.equal(matchName('title', 'body').variant, 'none');
  });

  it('keeps created_at and updated_at apart', () => {
    // The single most damaging false positive available to a name matcher:
    // both are timestamps on the same container and they share a token.
    assert.ok(matchName('created_at', 'updated_at').score < 0.55);
  });

  it('scores a near-miss spelling in the fuzzy band', () => {
    const match = matchName('scheduled_at', 'schedule_at');
    assert.equal(match.variant, 'fuzzy');
    assert.ok(match.score > 0.55 && match.score <= 0.85);
  });

  it('treats reordered tokens as a weaker match than an ordered one', () => {
    const reordered = matchName('user_id', 'idUser');
    assert.equal(reordered.variant, 'reordered');
    assert.ok(reordered.score < 1);
  });
});

describe('matchContainer', () => {
  it('matches a plural table against a singular class at full strength', () => {
    assert.equal(matchContainer('posts', 'Post'), 1);
    assert.equal(matchContainer('categories', 'Category'), 1);
    assert.equal(matchContainer('people', 'Person'), 1);
  });

  it('does not equate affixed value-shape names', () => {
    const affixed = matchContainer('posts', 'PostRow');
    assert.equal(affixed, 0);
    assert.equal(matchContainer('posts', 'CreatePostInput'), 0);
    for (const [a,b] of [['', ''], ['---', '___'], ['users', 'UserProfile'], ['resumes', 'ResumeVersion']]) {
      assert.equal(matchContainer(a!, b!), 0);
    }
  });

  it('scores unrelated containers far below the gate', () => {
    assert.ok(matchContainer('posts', 'Invoice') < 0.3);
    assert.ok(matchContainer('users', 'AuditLog') < 0.3);
  });
});

describe('containerCore', () => {
  it('strips leading and trailing noise but never everything', () => {
    assert.deepEqual(containerCore('CreatePostInput'), ['post']);
    assert.equal(containerCoreKey('PostRepository'), 'post');
    assert.deepEqual(containerCore('Row'), ['row']);
  });
});

describe('stripContainerPrefix and matchNameInContainer', () => {
  it('drops a container prefix embedded in a field name', () => {
    assert.deepEqual(stripContainerPrefix(['post', 'id'], ['post']), ['id']);
    assert.deepEqual(stripContainerPrefix(['title'], ['post']), ['title']);
  });

  it('joins posts.post_id to Post.id, discounted for the strip', () => {
    const match = matchNameInContainer('post_id', 'posts', 'id', 'Post');
    assert.equal(match.variant, 'affix');
    assert.ok(match.score > 0.9 && match.score < 1);
  });

  it('does not invent a match when neither side has the prefix', () => {
    assert.equal(matchNameInContainer('title', 'posts', 'body', 'Post').score, 0);
  });
});

describe('string metrics', () => {
  it('levenshtein is a metric on the cases the matcher relies on', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', 'abc'), 0);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('abc', 'abd'), levenshtein('abd', 'abc'));
  });

  it('editSimilarity and jaccard stay within [0,1]', () => {
    assert.equal(editSimilarity('abc', 'abc'), 1);
    assert.equal(editSimilarity('', ''), 1);
    assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
    assert.equal(jaccard(['a'], ['b']), 0);
    assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  });
});

describe('literalKey', () => {
  it('is stable under separator and case changes only', () => {
    assert.equal(literalKey('Scheduled-At'), 'scheduled_at');
    assert.notEqual(literalKey('posts'), literalKey('post'));
  });
});
