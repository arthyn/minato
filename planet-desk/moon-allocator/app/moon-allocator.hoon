/+  default-agent, dbug
|%
+$  shortname  @tas
+$  alloc-id   @ud
+
+$  allocation
  $:  id=alloc-id
      short=shortname
      moon=@p
      ticket=@t
      issued=@da
      issuer=@p
      note=(unit @t)
  ==
+
+$  state-0
  $:  next-id=alloc-id
      by-short=(map shortname allocation)
      events=(list allocation)
  ==
+
+$  versioned-state
  $%  [%0 state-0]
  ==
+
+$  action
  $%  [%ensure short=shortname]
      [%allocate short=shortname]
      [%set-note short=shortname note=@t]
  ==
+
+$  result
  $%  [%ok allocation]
      [%err code=@tas msg=@t]
  ==
--
%-  agent:dbug
^-  agent:gall
|_  =bowl:gall
+*  this      .
    def       ~(. (default-agent this %|) bowl)
::
++  on-init
  ^-  (quip card _this)
  `this(state [%0 next-id=1 by-short=~(mop by *(map shortname allocation)) events=~])
::
++  on-save   on-save:def
++  on-load
  |=  old=vase
  ^-  (quip card _this)
  =/  v  !<(versioned-state old)
  ?-  -.v
    %0  `this(state v)
  ==
::
++  is-trusted
  |=  who=@p
  ^-  ?
  =(who our.bowl)
::
++  valid-short
  |=  s=shortname
  ^-  ?
  ?&  ?>(?=(%tas -.!>(s)) %.y)
      (gte (met 3 s) 2)
      (lte (met 3 s) 20)
  ==
::
++  alloc-to-result
  |=  a=allocation
  ^-  vase
  !>([%ok a]:result)
::
++  err-result
  |=  [code=@tas msg=@t]
  ^-  vase
  !>([%err code msg]:result)
::
++  do-allocate
  |=  short=shortname
  ^-  (unit allocation)
  :: TODO: wire real moon allocator authority call.
  ~
::
++  on-poke
  |=  [=mark =vase]
  ^-  (quip card _this)
  ?+    mark  (on-poke:def mark vase)
    %noun
      ?>  (is-trusted src.bowl)
      =/  act  !<(action vase)
      ?-  -.act
        %set-note
          =/  cur  (~(get by-short state) short.act)
          ?~  cur
            :_  this
            :~  [%give %fact ~ %noun (err-result %not-found 'unknown shortname')]
            ==
          =/  upd  cur(note [~ note.act])
          =.  by-short.state  (~(put by-short state) short.act upd)
          :_  this
          :~  [%give %fact ~ %noun !>([%ok upd]:result)]
          ==
        %allocate
          =/  cur  (~(get by-short state) short.act)
          ?~  cur
            =/  made  (do-allocate short.act)
            ?~  made
              :_  this
              :~  [%give %fact ~ %noun (err-result %alloc-unimplemented 'allocator hook not wired yet')]
              ==
            =.  by-short.state  (~(put by-short state) short.act u.made)
            =.  events.state  [u.made events.state]
            =.  next-id.state  +(next-id.state)
            :_  this
            :~  [%give %fact ~ %noun !>([%ok u.made]:result)]
            ==
          :_  this
          :~  [%give %fact ~ %noun (err-result %already-exists 'shortname already allocated')]
          ==
        %ensure
          =/  cur  (~(get by-short state) short.act)
          ?~  cur
            =/  made  (do-allocate short.act)
            ?~  made
              :_  this
              :~  [%give %fact ~ %noun (err-result %alloc-unimplemented 'allocator hook not wired yet')]
              ==
            =.  by-short.state  (~(put by-short state) short.act u.made)
            =.  events.state  [u.made events.state]
            =.  next-id.state  +(next-id.state)
            :_  this
            :~  [%give %fact ~ %noun !>([%ok u.made]:result)]
            ==
          :_  this
          :~  [%give %fact ~ %noun !>([%ok u.cur]:result)]
          ==
      ==
  ==
::
++  on-peek
  |=  =path
  ^-  (unit (unit cage))
  ?+    path  ~
      [%x %alloc %list ~]
    `[~ %noun !>(events.state)]
      [%x %alloc %export ~]
    `[~ %noun !>(state)]
      [%x %alloc %by-short short=@tas ~]
    =/  got  (~(get by-short state) short)
    `[~ %noun !>(got)]
  ==
::
++  on-watch  on-watch:def
++  on-leave  on-leave:def
++  on-agent  on-agent:def
++  on-arvo   on-arvo:def
++  on-fail   on-fail:def
--
