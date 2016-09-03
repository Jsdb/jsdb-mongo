TASKS
-----

Shallow mode
============

A fetch or a query in shallow mode will return only the urls of the found elements. 

Elements will be sent to the client as value events with a specific flag indicating that the value is not complete.


Projections
===========

The client will specify which elements to receive. If applied to a fetch, it's equivalent to fetching each specified
subelement separatedly. If applied to a query, value events for subelements will be sent.

Elements will be sent to the client as value events with a specific flag indicating that the value is not complete.


Simple Query Fetch
==================

Simple queries are like Firebase ones, they have the following limits :

- The field on which the select and the ordering is done is the same
- It can work on a subpath, not inside a subcollection


Simple Query Update
===================

Given that the query is on a single field, saving the actual range for the field values sent to the client should be enought to :

- Decide whether an object that has just been updated on that field falls inside the current range or not
- If it falls inside the range 
 - Tell the client about the new object
 - Let the client remove the last element of the list
- If it was inside the range but moved out (given we have access to the previous value)
 - Tell the client the object went outside the range
 - Tell the client which new object came in by querying down the range

 A simpler way could be to store (_id->sort value) in an ordered array. when a modification is detected, the following is done :

- Check if the element is now inside the values (that is, it is bigger than the element at 0 and smaller that the last element)
- If it is outside
 - If it was not inside before, nothing changed


Better Query
============

Better queries should support the following :

- StartsWith or regexps : it's just a matter of using a regexp instead of equals
- Find in sub lists : for example, find all users that has in their following list a given value (but would not support the limits, cause a single element could return a lot of results).
- And/or : as long as they are at the same level of nesting, they can be combined in a single query
- Not : it's just a matter of inverting the conditions


Count
=====

Could be exposed as a special property of any collection. For example /users/*count, will be translated to a count operation on _id:/^\/users\/[^\/]+$/
and returned as the value.

Any write on a *count property will be ignored.


Complex queries
===============

Same features as better queries, but also on nested elements and at different depth levels. 

It should be based on defined projections, when an update is made to a sub document, the same value is also saved up the tree to be used for queries. This way
better queries can be executed on a flat object. 


Optimize events
===============

Right now when there is a change, all possible events are sent. For example, given the structure :

```
users/2/address/0/name
```

if a client is listening on "users/2", "users/2/address" and on "users/2/address/0/name", when an update 
to "users/2/address/0" is done, three events are sent to the client, even if only one could be enought.

However, avoiding to send the event to the client twice is not enought: an update can be way more complex. 
If in the previous example the client was listening also on "users/2/address/0/line", sending only the 
"first event" without careful evaluation would not be correct.


TESTS
-----
