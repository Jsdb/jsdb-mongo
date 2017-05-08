Simple Security
===============

Simple security is a tree-organized set of rules. The tree represent the DB path tree, and each rule is a function.

For example, suppose the following tree :

```
/users
  /123
    /name = Simone
    /password = CantTellYou
    /projects
      /456 = true
/projects
  /456
    /name = 'Project A'
    /users
      /123 = true
  /567
    /name = 'Project B'
    /users
      /234 = true
```

Supose we want to enforce the following security rules :
- password field of the user should never be sent
- projects field of the user should be sent only to for the logged in user, cause it's a reserved field
- projects not in the logged in user's "projects" field should be invisible

Then we would to install the following rules :

```
ruleset.rule('users/$uid/password', false);
ruleset.rule('users/$uid/projects', (match, userData) => match.$uid == userData.id);
ruleset.rule('projects/$pid', (match, userData) => !!userData.projects[match.$pid]);
```

This implies that during auth, proper userData has been filled :

```
class MyAuthService implements AuthService {
    authenticate(socket :Socket, authData :any) {
        return db(User).query().onField('email', authData.email).load(this, (users) => {
            if (users.length == 0) throw new Error("User not found");
            var user = users[0];
            if (user.password != authData.password) throw new Error("Wrong password");
            return {
                id: db(user).getId(),
                projects: user.projects
            }
        });
    }
}
```

Rules are evaluated following this algorithm :
- When a value V is being sent for path Pv
- The path and value are normalized into a tree structure, yielding a value RV with Prv = ''
- The tree of rules if then recursively navigated, starting with CV = RV and Match = {}, for each node :
 - if ket K is "__function", if it's a function execute the function, otherwise consider the value as function result value
   - if return value is true, proceed
   - if return value is false, remove current value from RV
   - if return value is an object, replace currenct value with returned value
   - TODO if value is a promise, defer above rules to promise resolve (wrap anyway in Promise.resolve?)
 - if key K does not start with "$", if CV[K] esits, CV = CV[K] and children of current node are evaluated 
 - if key K starts with $, then for each child CH of CV :
   - set Match[K] = key of CH
   - set CV = CH
   - evaluate children of current node

Suppose for example the following value is being sent :

```
path: '/users/123', value: {name:'Simone',password:'CantTellYou',projects:{"456":true}}
```

This would be normalized to the following object :
{
    users: {
        "123" : {
            name:'Simone',
            password:'CantTellYou',
            projects:{
                "456":true
            }
        }
    }
}

While the rules above would have been normalized to the following object :

{
    users: {
        "$uid" : {
            password: {
                __function: false
            },
            projects: {
                __function: (match, userData) => match.$uid == userData.id
            }
        }
    },
    projects: {
        "$pid" : {
            __function: (match, userData) => !!userData.projects[match.$pid]
        }
    }
}

The algorithm will the proceed as follows :
- CV = RV, CN = RN
- Found key 'users' in CN, found CV[users], recurse 
 - CV = CV[users], CN = CN[users]
 - Found key '$uid' in CN, recurse for each CV[*] :
   - CV = CV[123], CN = CN[$uid]
   - Match[$uid] = 123
   - Found key 'password' in CN, recurse
     - CV = CV[password], CN = CN[password]
     - Found key '__function' in CN, execute function, returns false
     - Remove CV from its parent (return false?)
   - Found key 'projects' in CN, recurse
     - CV = CV[projects], CN = CN[projects]
     - Found key '__function' in CN, execute function, returns an object
     - Replace CV with the object in its parent (return it?)
   - No other keys, return
 - No other keys, return
- Found key 'projects' in CN, not found CV[projects], skip
- No other keys, completed

Once RV has been modified by relevant functions, the original normalization is reverted, taking
the modified value from RV using the original path.

